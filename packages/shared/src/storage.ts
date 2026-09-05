import { readdir, stat, rm } from "node:fs/promises"
import path from "node:path"

/** Account managed regular files, including metadata; do not follow symlinks. */
export async function storageBytes(root: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) total += await storageBytes(file)
    else if (entry.isFile()) total += (await stat(file)).size
  }
  return total
}

/** Canonical CAS addresses are never collected. Only abandoned publication temps. */
export async function collectAbandonedTemps(root: string, now = Date.now()): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) await collectAbandonedTemps(file, now)
    else if (
      entry.isFile() &&
      entry.name.startsWith(".tmp-") &&
      (await stat(file)).mtimeMs < now - 86_400_000
    )
      await rm(file, { force: true })
  }
}
