/**
 * Plugin options schema with defaults.
 *
 * All values have defaults so the plugin works out of the box with zero config.
 * The schema is validated via zod at factory entry.
 */
import { z } from "zod"
import { defaultDataDir } from "@bluecode/shared"
import { DEFAULT_RETAIN_RECENT_TURNS, summaryProviderSchema } from "@bluecode/contracts"

export const RtkOptionsSchema = z.object({
  mode: z.enum(["off", "shadow", "on"]).optional(),
  budgetTokens: z.number().int().positive().default(512),
  timeoutMs: z.number().int().positive().default(40),
  minBytes: z.number().int().nonnegative().default(512),
  entry: z.string().optional(),
})

export type RtkOptions = z.infer<typeof RtkOptionsSchema>

export const SummarizerOptionsSchema = summaryProviderSchema

export const HeadroomOptionsSchema = z.object({
  mode: z.enum(["off", "shadow", "on"]).optional(),
  strategy: z.enum(["legacy", "layered"]).default("legacy"),
  memoryMaxTokens: z.number().int().nonnegative().max(16384).default(4096),
  memoryRatio: z.number().min(0).max(1).default(0.15),
  summarizer: SummarizerOptionsSchema.default(SummarizerOptionsSchema.parse({})),
  targetRatio: z.number().min(0).max(1).default(0.55),
  triggerRatio: z.number().min(0).max(1).default(0.7),
  retainRecentTurns: z.number().int().nonnegative().optional(),
  fallback: z.enum(["passthrough", "upstream"]).default("upstream"),
  socketPath: z.string().optional(),
  idleExitMs: z.number().int().positive().optional(),
  entry: z.string().optional(),
}).transform(options => ({ ...options,
  retainRecentTurns: options.retainRecentTurns ?? DEFAULT_RETAIN_RECENT_TURNS[options.strategy],
}))

export type HeadroomOptions = z.infer<typeof HeadroomOptionsSchema>

export const PluginOptionsSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["off", "shadow", "on"]).default("on"),
  maxStorageBytes: z
    .number()
    .int()
    .positive()
    .default(1024 ** 3),
  // uid/XDG_RUNTIME_DIR-namespaced default (shared/paths.ts): a plain shared
  // <tmpdir>/bluecode-headroom is writable by every account on multi-user
  // hosts, so one account could attach to another account's daemon socket.
  dataDir: z.string().optional().default(defaultDataDir),
  // zod v4 types .default against the OUTPUT shape (inner defaults make every
  // field required), so the fallback must spell the values out — which also
  // keeps this in sync with the inner .default()s visible right above.
  rtk: RtkOptionsSchema.default({ budgetTokens: 512, timeoutMs: 40, minBytes: 512 }),
  headroom: HeadroomOptionsSchema.default({
    strategy: "legacy",
    memoryMaxTokens: 4096,
    memoryRatio: 0.15,
    summarizer: SummarizerOptionsSchema.parse({}),
    triggerRatio: 0.7,
    targetRatio: 0.55,
    retainRecentTurns: DEFAULT_RETAIN_RECENT_TURNS.legacy,
    fallback: "upstream",
  }),
  sidecarDir: z.string().optional(),
})

export type PluginOptions = z.infer<typeof PluginOptionsSchema>

/** Parse and validate options with defaults applied. */
export function parseOptions(input: unknown): PluginOptions {
  return PluginOptionsSchema.parse(input)
}

/** Default options (for testing and reference). */
export const DEFAULT_OPTIONS: PluginOptions = PluginOptionsSchema.parse({})
