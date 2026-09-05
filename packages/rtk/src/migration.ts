/** Offline migration preserves legacy addresses and requires explicit project attribution. */
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { mkdir, open, rename, rm, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fetchParamsSchema, type FetchResult } from "@bluecode/contracts"
import { readObject, writeObject, paginateText, storageBytes } from "@bluecode/shared"
import { openOwnershipStore } from "./ownership"

export function createLegacyRtkReader(options: { dataDir: string; projectId: string }) {
  const db = new Database(path.join(options.dataDir, "rtk-meta.db"), { readonly: true })
  return {
    close: () => db.close(),
    async fetch(input: unknown): Promise<FetchResult> {
      const params = fetchParamsSchema.parse(input)
      let namespace: unknown
      try {
        namespace = JSON.parse(params.sessionId)
      } catch {
        return { found: false }
      }
      if (
        !Array.isArray(namespace) ||
        namespace.length !== 2 ||
        namespace[0] !== options.projectId ||
        typeof namespace[1] !== "string"
      )
        return { found: false }
      const hash = params.hash.slice(7)
      if (!db.query("SELECT 1 FROM rtk_refs WHERE session_id=? AND hash=?").get(namespace[1], hash))
        return { found: false }
      const bytes = await readObject(options.dataDir, hash)
      if (!bytes) return { found: false }
      const page = paginateText(new TextDecoder().decode(bytes), {
        ...params,
        ref: `${params.sessionId}:${params.hash}`,
      })
      return {
        found: true,
        content: page.content,
        nextCursor: page.nextCursor,
        truncated: page.truncated,
      }
    },
  }
}

export async function migrateLegacyRtk(options: {
  dataDir: string
  legacyDataDir?: string
  projectId: string
  offline: true
  maxStorageBytes?: number
}) {
  if (options.offline !== true || !options.projectId)
    throw new Error("Offline migration requires an explicit project ID")
  const source = options.legacyDataDir ?? options.dataDir
  const identity = { source: path.resolve(source), projectId: options.projectId }
  const parent = path.join(options.dataDir, "storage-v2"),
    target = path.join(parent, "rtk")
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const lockPath = path.join(parent, ".rtk-migration.lock")
  const lock = await open(lockPath, "wx", 0o600)
  const stage = path.join(parent, `.tmp-rtk-${crypto.randomUUID()}`)
  try {
    if (existsSync(path.join(target, "migration.json"))) {
      const previous = JSON.parse(await readFile(path.join(target, "migration.json"), "utf8"))
      if (
        previous.version !== 2 ||
        previous.source !== identity.source ||
        previous.projectId !== identity.projectId
      )
        throw new Error("RTK migration identity differs: verify source and project mapping")
      return { dataDir: target, objects: 0, status: "already-migrated" as const }
    }
    if (existsSync(target))
      throw new Error("Target RTK store already exists; refusing to overwrite")
    const legacy = new Database(path.join(source, "rtk-meta.db"), { readonly: true })
    let rows: Array<{ session_id: string; hash: string }>
    try {
      rows = legacy
        .query("SELECT session_id, hash FROM rtk_refs ORDER BY hash, session_id")
        .all() as typeof rows
    } finally {
      legacy.close()
    }
    await mkdir(stage, { mode: 0o700 })
    const ledger = openOwnershipStore(stage)
    const copied = new Set<string>()
    const quota = options.maxStorageBytes ?? 1024 ** 3
    try {
      for (const row of rows) {
        if (!copied.has(row.hash)) {
          const bytes = await readObject(source, row.hash)
          if (!bytes) throw new Error(`Missing legacy object ${row.hash}`)
          if (!ledger.reserve(row.hash, bytes.byteLength, quota))
            throw new Error("RTK migration storage capacity exceeded")
          await writeObject(stage, bytes)
          copied.add(row.hash)
        }
        ledger.grant(JSON.stringify([options.projectId, row.session_id]), row.hash)
      }
    } finally {
      ledger.close()
    }
    await writeFile(
      path.join(stage, "migration.json"),
      JSON.stringify({ version: 2, ...identity, objects: copied.size }),
      { mode: 0o600 }
    )
    if ((await storageBytes(stage)) > quota)
      throw new Error("RTK migration storage capacity exceeded after metadata creation")
    await rename(stage, target)
    const directory = await open(parent, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return { dataDir: target, objects: copied.size, status: "migrated" as const }
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
    await rm(stage, { recursive: true, force: true })
  }
}
