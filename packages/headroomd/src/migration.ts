/** Explicit offline copy/verify/switch. Never opens a legacy ledger writable. */
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { mkdir, open, cp, rename, rm, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { HeadroomRetrieveParams, HeadroomRetrieveResult } from "@bluecode/contracts"
import { paginateText, encodeCursor, decodeCursor } from "@bluecode/shared"
import { readMessageObject, renderProjection } from "./store/objects"
import { createEngine } from "./engine"
import { storageBytes } from "./store/quota"

export function createLegacyReader(dataDir: string): {
  retrieve(params: HeadroomRetrieveParams): Promise<HeadroomRetrieveResult>
  close(): void
} {
  const db = new Database(path.join(dataDir, "meta.db"), { readonly: true })
  const table = db.prepare("SELECT name FROM sqlite_master WHERE name='archive_refs'").get()
    ? "archive_refs"
    : "cas_meta"
  return {
    close: () => db.close(),
    async retrieve(params) {
      const ns = params.namespace
      if ("hash" in params) {
        const owned = db
          .prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND session_id=? AND hash=?`)
          .get(ns.projectId, ns.sessionId, params.hash)
        if (!owned) return { found: false }
        const projection = await readMessageObject(dataDir, params.hash)
        return projection
          ? {
              found: true,
              ...paginateText(renderProjection(projection), { ...params, ref: params.hash }),
            }
          : { found: false }
      }
      if ("historyHash" in params) {
        const owned = db
          .prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND session_id=? AND history_hash=?`)
          .get(ns.projectId, ns.sessionId, params.historyHash)
        if (!owned) return { found: false }
        const ref = JSON.stringify([ns, params.historyHash]),
          pieces = params.cursor?.split(".")
        if (pieces && pieces.length !== 2) throw new Error("Invalid legacy history cursor")
        let offset = pieces ? decodeCursor(pieces[0], ref) : params.offset ?? 0
        const row = db
          .prepare(
            `SELECT hash,role,turn_index AS turnIndex FROM ${table} WHERE project_id=? AND session_id=? AND history_hash=? ORDER BY msg_seq LIMIT 1 OFFSET ?`
          )
          .get(ns.projectId, ns.sessionId, params.historyHash, offset) as {
          hash: string
          role: "user" | "assistant"
          turnIndex: number
        } | null
        if (!row)
          return {
            found: true,
            items: [],
            nextOffset: null,
            nextCursor: null,
            truncated: false,
            partial: false,
            missingHashes: [],
          }
        const projection = await readMessageObject(dataDir, row.hash)
        let intra = pieces ? decodeCursor(pieces[1], `${ref}:${offset}`) : 0
        const page = projection
          ? paginateText(renderProjection(projection), {
              ref: row.hash,
              cursor: encodeCursor(row.hash, intra),
              maxBytes: params.maxBytes,
              maxTokens: params.maxTokens,
            })
          : null
        if (page?.nextCursor) intra = decodeCursor(page.nextCursor, row.hash)
        else {
          offset++
          intra = 0
        }
        const more = !!db
          .prepare(
            `SELECT 1 FROM ${table} WHERE project_id=? AND session_id=? AND history_hash=? ORDER BY msg_seq LIMIT 1 OFFSET ?`
          )
          .get(ns.projectId, ns.sessionId, params.historyHash, offset)
        return {
          found: true,
          items: page
            ? [
                {
                  contentHash: row.hash,
                  role: row.role,
                  turnIndex: row.turnIndex,
                  content: page.content,
                },
              ]
            : [],
          nextOffset: more ? offset : null,
          nextCursor: more
            ? `${encodeCursor(ref, offset)}.${encodeCursor(`${ref}:${offset}`, intra)}`
            : null,
          truncated: more,
          partial: !page,
          missingHashes: page ? [] : [row.hash],
        }
      }
      // Legacy reads do not repair or mutate the old derived DB. Callers may
      // migrate offline to enable the v2 full-text index.
      throw new Error(
        "Legacy query requires offline migration; hash/history retrieval is read-only"
      )
    },
  }
}

export async function migrateLegacyHeadroom(options: {
  dataDir: string
  legacyDataDir?: string
  offline: true
  maxStorageBytes?: number
  projectMappings?: Record<string, string>
}): Promise<{ dataDir: string; objects: number; status: "migrated" | "already-migrated" }> {
  if (options.offline !== true) throw new Error("Offline migration requires explicit offline mode")
  const root = options.dataDir,
    source = options.legacyDataDir ?? root,
    parent = path.join(root, "storage-v2"),
    target = path.join(parent, "headroom")
  const identity = {
    source: path.resolve(source),
    projectMappings: Object.entries(options.projectMappings ?? {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    ),
  }
  if (existsSync(path.join(source, "headroomd.sock")))
    throw new Error("Legacy socket exists: stop the daemon before offline migration")
  await mkdir(parent, { recursive: true })
  const lock = path.join(parent, ".headroom-migration.lock")
  const exclusive = await open(lock, "wx", 0o600)
  const stage = path.join(parent, `.tmp-headroom-${process.pid}-${Date.now()}`)
  try {
    if (existsSync(path.join(target, "migration.json"))) {
      const previous = JSON.parse(await readFile(path.join(target, "migration.json"), "utf8"))
      if (
        previous.version !== 2 ||
        previous.source !== identity.source ||
        JSON.stringify(previous.projectMappings) !== JSON.stringify(identity.projectMappings)
      )
        throw new Error("Headroom migration identity differs: verify source and project mapping")
      return { dataDir: target, objects: 0, status: "already-migrated" }
    }
    if (existsSync(target))
      throw new Error("Target headroom store already exists; refusing to overwrite")
    await mkdir(stage, { mode: 0o700 })
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(path.join(source, `meta.db${suffix}`)))
        await cp(path.join(source, `meta.db${suffix}`), path.join(stage, `meta.db${suffix}`))
    if (existsSync(path.join(source, "objects")))
      await cp(path.join(source, "objects"), path.join(stage, "objects"), { recursive: true })
    if ((await storageBytes(stage)) > (options.maxStorageBytes ?? 1024 * 1024 * 1024))
      throw new Error("Headroom migration storage capacity exceeded")
    const db = new Database(path.join(stage, "meta.db"), { readonly: true })
    const rows = db.prepare("SELECT hash FROM cas_meta").all() as { hash: string }[]
    db.close()
    for (const { hash } of rows)
      if (!(await readMessageObject(stage, hash)))
        throw new Error(`Missing migration object ${hash}`)
    if (options.projectMappings) {
      const mapped = new Database(path.join(stage, "meta.db"))
      try {
        mapped
          .transaction(() => {
            const tables = ["cas_meta", "archive_refs", "archive_manifests", "active_views"].filter(
              (name) => mapped.query("SELECT 1 FROM sqlite_master WHERE name=?").get(name)
            )
            const mappings = Object.entries(options.projectMappings!).map(([from, to]) => ({
              from,
              to,
              temp: `migration-${crypto.randomUUID()}`,
            }))
            for (const { from, to, temp } of mappings) {
              if (!to || !mapped.query("SELECT 1 FROM cas_meta WHERE project_id=?").get(from))
                throw new Error(`Unknown or invalid project mapping: ${from}`)
              for (const table of tables)
                mapped.query(`UPDATE ${table} SET project_id=? WHERE project_id=?`).run(temp, from)
            }
            for (const { to, temp } of mappings)
              for (const table of tables)
                mapped.query(`UPDATE ${table} SET project_id=? WHERE project_id=?`).run(to, temp)
          })
          .immediate()
      } finally {
        mapped.close()
      }
    }
    const engine = await createEngine({
      dataDir: stage,
      ...(options.maxStorageBytes !== undefined
        ? { maxStorageBytes: options.maxStorageBytes }
        : {}),
    })
    engine.close()
    await writeFile(
      path.join(stage, "migration.json"),
      JSON.stringify({ version: 2, ...identity, objects: rows.length }),
      { mode: 0o600 }
    )
    if ((await storageBytes(stage)) > (options.maxStorageBytes ?? 1024 * 1024 * 1024))
      throw new Error("Headroom migration storage capacity exceeded after index rebuild")
    await rename(stage, target)
    const directory = await open(parent, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return { dataDir: target, objects: rows.length, status: "migrated" }
  } finally {
    await exclusive.close()
    await rm(lock, { force: true })
    await rm(stage, { recursive: true, force: true })
  }
}
