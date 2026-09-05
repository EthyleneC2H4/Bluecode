#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { defaultDataDir, storageLayout } from "../packages/shared/src/paths"
import { collectAbandonedTemps, storageBytes } from "../packages/shared/src/storage"
const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--dataDir"))
  throw new Error("Usage: bun run gc [--dataDir PATH]")
const layout = storageLayout(args[1] ?? defaultDataDir())
for (const store of [layout.rtk, layout.headroom])
  if (existsSync(store)) {
    const before = await storageBytes(store)
    await collectAbandonedTemps(store)
    console.log(
      JSON.stringify({
        store,
        bytesFreed: before - (await storageBytes(store)),
        policy: "abandoned temporary files older than 24h only",
      })
    )
  }
