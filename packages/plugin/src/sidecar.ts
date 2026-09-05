/** Pure per-configuration entry resolution; no process-global option cache. */
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PluginOptions } from "./config"

export function resolveRtkEntry(options: PluginOptions): string | undefined {
  if (options.rtk.entry !== undefined) return options.rtk.entry
  const dir = options.sidecarDir ?? process.env.BLUECODE_SIDECAR_DIR
  return dir === undefined ? undefined : path.join(dir, "rtk", "src", "bin.ts")
}
export function resolveHeadroomEntry(options: PluginOptions): string {
  if (options.headroom.entry !== undefined) return options.headroom.entry
  const dir = options.sidecarDir ?? process.env.BLUECODE_SIDECAR_DIR
  return dir === undefined
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../headroomd/src/bin.ts")
    : path.join(dir, "headroomd", "src", "bin.ts")
}
/** Deprecated test compatibility; resolution is now stateless. */
export function clearSidecarCache(): void {}
