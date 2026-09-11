/**
 * Plugin options schema with defaults.
 *
 * All values have defaults so the plugin works out of the box with zero config.
 * The schema is validated via zod at factory entry.
 */
import { z } from "zod"
import { defaultDataDir } from "@bluecode/shared"

export const RtkOptionsSchema = z.object({
  mode: z.enum(["off", "shadow", "on"]).optional(),
  budgetTokens: z.number().int().positive().default(512),
  timeoutMs: z.number().int().positive().default(40),
  minBytes: z.number().int().nonnegative().default(512),
  entry: z.string().optional(),
})

export type RtkOptions = z.infer<typeof RtkOptionsSchema>

export const SummarizerOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  baseURL: z.url().optional(),
  model: z.string().min(1).optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  timeoutMs: z.number().int().positive().max(10000).default(10000),
  maxInputTokens: z.number().int().positive().max(8192).default(8192),
  maxOutputTokens: z.number().int().positive().max(1024).default(1024),
  sessionInputTokens: z.number().int().positive().max(32768).default(32768),
  sessionOutputTokens: z.number().int().positive().max(4096).default(4096),
}).strict().refine((value) => !value.enabled || Boolean(value.baseURL && value.model && value.apiKeyEnv), {
  message: "Enabled summarizer requires baseURL, model and apiKeyEnv (never a literal API key)",
})

export const HeadroomOptionsSchema = z.object({
  mode: z.enum(["off", "shadow", "on"]).optional(),
  strategy: z.enum(["legacy", "layered"]).default("legacy"),
  memoryMaxTokens: z.number().int().nonnegative().max(16384).default(4096),
  memoryRatio: z.number().min(0).max(1).default(0.15),
  summarizer: SummarizerOptionsSchema.default(SummarizerOptionsSchema.parse({})),
  targetRatio: z.number().min(0).max(1).default(0.55),
  triggerRatio: z.number().min(0).max(1).default(0.7),
  retainRecentTurns: z.number().int().nonnegative().default(4),
  fallback: z.enum(["passthrough", "upstream"]).default("upstream"),
  socketPath: z.string().optional(),
  idleExitMs: z.number().int().positive().optional(),
  entry: z.string().optional(),
})

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
    retainRecentTurns: 4,
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
