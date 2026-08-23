/**
 * Sidecar binary location logic.
 *
 * Resolution order (first match wins):
 * 1. Explicit option (rtk.entry / headroom.entry / sidecarDir)
 * 2. Environment variable BLUECODE_SIDECAR_DIR
 * 3. Package-relative paths: ../../rtk/src/bin.ts and ../../headroomd/src/bin.ts
 *    (resolved relative to this file)
 * 4. Throw (caller degrades)
 *
 * Results are cached per process.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginOptions } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cached resolution results
let cachedRtkEntry: string | null = null;
let cachedHeadroomEntry: string | null = null;

/**
 * Resolve the rtk sidecar entry point.
 */
export function resolveRtkEntry(options: PluginOptions): string {
  if (cachedRtkEntry !== null) return cachedRtkEntry;

  // 1. Explicit rtk.entry option
  if (options.rtk.entry !== undefined) {
    cachedRtkEntry = options.rtk.entry;
    return cachedRtkEntry;
  }

  // 2. BLUECODE_SIDECAR_DIR env
  const envDir = process.env.BLUECODE_SIDECAR_DIR;
  if (envDir !== undefined) {
    cachedRtkEntry = path.join(envDir, "rtk", "src", "bin.ts");
    return cachedRtkEntry;
  }

  // 3. Package-relative fallback
  cachedRtkEntry = path.resolve(__dirname, "../../rtk/src/bin.ts");
  return cachedRtkEntry;
}

/**
 * Resolve the headroomd sidecar entry point.
 */
export function resolveHeadroomEntry(options: PluginOptions): string {
  if (cachedHeadroomEntry !== null) return cachedHeadroomEntry;

  // 1. Explicit headroom.entry option
  if (options.headroom.entry !== undefined) {
    cachedHeadroomEntry = options.headroom.entry;
    return cachedHeadroomEntry;
  }

  // 2. BLUECODE_SIDECAR_DIR env
  const envDir = process.env.BLUECODE_SIDECAR_DIR;
  if (envDir !== undefined) {
    cachedHeadroomEntry = path.join(envDir, "headroomd", "src", "bin.ts");
    return cachedHeadroomEntry;
  }

  // 3. Package-relative fallback
  cachedHeadroomEntry = path.resolve(__dirname, "../../headroomd/src/bin.ts");
  return cachedHeadroomEntry;
}

/**
 * Clear cached entries (test-only).
 */
export function clearSidecarCache(): void {
  cachedRtkEntry = null;
  cachedHeadroomEntry = null;
}