#!/usr/bin/env bun
/** Explicit offline migration. Source stores are retained; no implicit namespace fallback. */
import { existsSync } from "node:fs"
import path from "node:path"
import { migrateLegacyHeadroom } from "../packages/headroomd/src/migration"
import { migrateLegacyRtk } from "../packages/rtk/src/migration"
import { defaultDataDir } from "../packages/shared/src/paths"

export function parseMigrationArgs(argv: string[]) {
  const values: Record<string, string> = {}
  let offline = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--offline") {
      offline = true
      continue
    }
    if (
      ![
        "--dataDir",
        "--legacyDataDir",
        "--projectId",
        "--legacyProject",
        "--component",
        "--maxStorageBytes",
      ].includes(arg)
    )
      throw new Error(`Unknown migration argument ${arg}`)
    const value = argv[++i]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
    values[arg.slice(2)] = value
  }
  if (!offline) throw new Error("Stop the plugin/sidecars, then explicitly pass --offline")
  if (!values.projectId)
    throw new Error("--projectId must name the actual OpenCode project that owns this archive")
  const component = values.component ?? "both"
  if (!["rtk", "headroom", "both"].includes(component))
    throw new Error("--component must be rtk, headroom, or both")
  const maxStorageBytes = Number(values.maxStorageBytes ?? 1024 ** 3)
  if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < 2)
    throw new Error("Invalid maxStorageBytes")
  return {
    dataDir: values.dataDir ?? defaultDataDir(),
    legacyDataDir: values.legacyDataDir ?? values.dataDir ?? defaultDataDir(),
    projectId: values.projectId,
    legacyProject: values.legacyProject ?? "default",
    component,
    maxStorageBytes,
    offline: true as const,
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseMigrationArgs(argv)
  const results: Record<string, unknown> = {}
  const allowance =
    options.component === "both" ? Math.floor(options.maxStorageBytes / 2) : options.maxStorageBytes
  if (
    options.component !== "headroom" &&
    existsSync(path.join(options.legacyDataDir, "rtk-meta.db"))
  )
    results.rtk = await migrateLegacyRtk({ ...options, maxStorageBytes: allowance })
  if (options.component !== "rtk" && existsSync(path.join(options.legacyDataDir, "meta.db")))
    results.headroom = await migrateLegacyHeadroom({
      ...options,
      maxStorageBytes: allowance,
      projectMappings: { [options.legacyProject]: options.projectId },
    })
  if (!Object.keys(results).length)
    throw new Error("No selected legacy ledger found; source and target paths were not changed")
  console.log(JSON.stringify({ sourceRetained: options.legacyDataDir, stores: results }, null, 2))
}
if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(String(error))
    process.exitCode = 1
  })
