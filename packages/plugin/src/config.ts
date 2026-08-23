/**
 * Plugin options schema with defaults.
 *
 * All values have defaults so the plugin works out of the box with zero config.
 * The schema is validated via zod at factory entry.
 */
import { z } from "zod";
import { tmpdir } from "node:os";
import path from "node:path";

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
  dataDir: z.string().optional().default(() => path.join(tmpdir(), "bluecode-headroom")),
  rtk: RtkOptionsSchema.default({}),
  headroom: HeadroomOptionsSchema.default({}),
  sidecarDir: z.string().optional(),
});

export type PluginOptions = z.infer<typeof PluginOptionsSchema>;

/** Parse and validate options with defaults applied. */
export function parseOptions(input: unknown): PluginOptions {
  return PluginOptionsSchema.parse(input);
}

/** Default options (for testing and reference). */
export const DEFAULT_OPTIONS: PluginOptions = PluginOptionsSchema.parse({});