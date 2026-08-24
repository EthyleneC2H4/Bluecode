/**
 * Plugin options schema with defaults.
 *
 * All values have defaults so the plugin works out of the box with zero config.
 * The schema is validated via zod at factory entry.
 */
import { z } from "zod";
import { defaultSidecarDataDir } from "@bluecode/shared";

export const RtkOptionsSchema = z.object({
  budgetTokens: z.number().int().positive().default(512),
  timeoutMs: z.number().int().positive().default(40),
  minBytes: z.number().int().nonnegative().default(512),
  entry: z.string().optional(),
});

export type RtkOptions = z.infer<typeof RtkOptionsSchema>;

export const HeadroomOptionsSchema = z.object({
  triggerRatio: z.number().min(0).max(1).default(0.7),
  retainRecentTurns: z.number().int().nonnegative().default(4),
  fallback: z.enum(["passthrough", "upstream"]).default("upstream"),
  socketPath: z.string().optional(),
  idleExitMs: z.number().int().positive().optional(),
  entry: z.string().optional(),
});

export type HeadroomOptions = z.infer<typeof HeadroomOptionsSchema>;

export const PluginOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  // uid/XDG_RUNTIME_DIR-namespaced default (shared/paths.ts): a plain shared
  // <tmpdir>/bluecode-headroom is writable by every account on multi-user
  // hosts, so one account could attach to another account's daemon socket.
  dataDir: z.string().optional().default(() => defaultSidecarDataDir("bluecode-headroom")),
  // zod v4 types .default against the OUTPUT shape (inner defaults make every
  // field required), so the fallback must spell the values out — which also
  // keeps this in sync with the inner .default()s visible right above.
  rtk: RtkOptionsSchema.default({ budgetTokens: 512, timeoutMs: 40, minBytes: 512 }),
  headroom: HeadroomOptionsSchema.default({
    triggerRatio: 0.7,
    retainRecentTurns: 4,
    fallback: "upstream",
  }),
  sidecarDir: z.string().optional(),
});

export type PluginOptions = z.infer<typeof PluginOptionsSchema>;

/** Parse and validate options with defaults applied. */
export function parseOptions(input: unknown): PluginOptions {
  return PluginOptionsSchema.parse(input);
}

/** Default options (for testing and reference). */
export const DEFAULT_OPTIONS: PluginOptions = PluginOptionsSchema.parse({});