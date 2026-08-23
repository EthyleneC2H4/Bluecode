/**
 * Sidecar entry resolution.
 *
 * The two sidecars have DIFFERENT default-resolution semantics, so each gets
 * its own resolver shape:
 *
 * - rtk (@bluecode/rtk RtkClient) self-resolves its entry as a sibling of its
 *   own module ("stable regardless of the caller's layout"), so when neither
 *   an explicit option nor BLUECODE_SIDECAR_DIR is set we return undefined and
 *   let the client resolve — guessing a plugin-relative path here would be
 *   strictly worse than the client's own default.
 *
 * - headroomd (HeadroomClient.connect) only connects when no spawn recipe is
 *   given — it never launches a daemon by itself. The plugin must therefore
 *   ALWAYS supply an entry for connect-or-spawn to self-heal, so this resolver
 *   has a package-relative fallback instead of returning undefined.
 *
 * Shared precedence (first match wins):
 * 1. Explicit option (rtk.entry / headroom.entry)
 * 2. Environment variable BLUECODE_SIDECAR_DIR
 * 3. rtk: undefined (client self-resolves) / headroomd: package-relative path
 *
 * Results are cached per process.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginOptions } from "./config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cached resolution results
let cachedRtkEntry: string | undefined | null = null;
let cachedHeadroomEntry: string | null = null;

/**
 * Resolve the rtk server entry to pass to RtkClient.create.
 * Returns undefined when the client should use its own module-sibling default.
 */
export function resolveRtkEntry(options: PluginOptions): string | undefined {
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

  // 3. Let RtkClient resolve its own bin (see module docstring).
  cachedRtkEntry = undefined;
  return undefined;
}

/**
 * Resolve the headroomd daemon entry for HeadroomClient.connect's spawn recipe.
 * Always returns a path: without it connect() never spawns, so a default-config
 * install could never self-heal a dead daemon.
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
