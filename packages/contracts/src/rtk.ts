/**
 * rtk JSONL protocol v1 — schemas and inferred types only (no runtime logic).
 *
 * Wire format: one JSON value per line. The first line a rtk server emits is
 * the hello handshake; every subsequent exchange is request/response envelopes
 * (see requestSchema/responseSchema). Per-op params are validated server-side
 * with the per-op param schemas exported below (implemented in M3).
 */
import { z } from "zod";
import { errorSchema } from "./errors";

export const PROTOCOL_VERSION = 1;

/**
 * Startup handshake — the first line a rtk server writes after spawn.
 */
export const helloSchema = z.object({
  proto: z.literal(1),
  pid: z.number().int().positive(),
});
export type Hello = z.infer<typeof helloSchema>;

/** Output-compression strategy chosen for a tool output. */
export type StrategyName = "ls" | "grep" | "read" | "diff" | "test" | "unknown";
// Note: the "ls" strategy also serves glob/globlist-style outputs
// (classification merge; finalized in M2).

/** Why a compress op degraded to passthrough. */
export type DegradedReason = "spawn_failed" | "timeout" | "crash" | "protocol" | "no_gain";

export const strategyNameSchema = z.enum(["ls", "grep", "read", "diff", "test", "unknown"]);
export const degradedReasonSchema = z.enum([
  "spawn_failed",
  "timeout",
  "crash",
  "protocol",
  "no_gain",
]);

/** Content reference: "sha256:" followed by exactly 64 lowercase hex chars. */
export const sha256RefSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected "sha256:<64 lowercase hex chars>"');

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

/** Hand-written mirror of the compress wire params (= z.input of the schema). */
export interface CompressParams {
  tool: string;
  output: string;
  title?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Compression token budget; applied by the server as 512 when omitted. */
  budgetTokens?: number | undefined;
  sessionId?: string | undefined;
  callId?: string | undefined;
}

export const compressParamsSchema = z.object({
  tool: z.string(),
  output: z.string(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  budgetTokens: z.number().int().positive().default(512),
  sessionId: z.string().optional(),
  callId: z.string().optional(),
});
export type CompressParamsParsed = z.output<typeof compressParamsSchema>;

export const compressResultSchema = z.object({
  output: z.string(),
  rawHash: sha256RefSchema, // "sha256:<hex>"
  strategy: strategyNameSchema,
  compressed: z.boolean(), // false = not compressed (fast path / no_gain passthrough)
  truncated: z.boolean(), // whether input carried an upstream truncation marker (metadata.truncated passthrough)
  rawTokensEst: z.number(),
  outTokensEst: z.number(),
  degraded: z.nullable(z.object({ reason: degradedReasonSchema })),
});
export type CompressResult = z.infer<typeof compressResultSchema>;

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/** Hand-written mirror of the fetch wire params. */
export interface FetchParams {
  /** Content hash to retrieve; format "sha256:<64 hex>". */
  hash: string;
}

export const fetchParamsSchema = z.object({ hash: sha256RefSchema });

export const fetchResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(true), content: z.string() }),
  z.object({ found: z.literal(false) }),
]);
export type FetchResult = z.infer<typeof fetchResultSchema>;

// ---------------------------------------------------------------------------
// ping / stats / simulateCrash
// ---------------------------------------------------------------------------

export const pingParamsSchema = z.object({});
export const pingResultSchema = z.object({
  pong: z.literal(true),
  uptimeMs: z.number(),
});
export type PingResult = z.infer<typeof pingResultSchema>;

export const statsParamsSchema = z.object({});
export const statsResultSchema = z.object({
  requests: z.number(),
  compressedCount: z.number(),
  passthroughCount: z.number(),
  degradedCounts: z.record(degradedReasonSchema, z.number()),
  uptimeMs: z.number(),
});
export type StatsResult = z.infer<typeof statsResultSchema>;

// simulateCrash: empty params; ONLY effective when BLUECODE_TEST=1 is set in
// the server environment — any other environment must answer E_PROTOCOL
// (the op is gated, not the params: `{}` is valid input).
// Implemented in M3; exists here so test harnesses can pin the wire shape.
export const simulateCrashParamsSchema = z.object({});

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export const rtkOpSchema = z.enum(["compress", "fetch", "ping", "stats", "simulateCrash"]);
export type RtkOp = z.infer<typeof rtkOpSchema>;

export const requestSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  op: rtkOpSchema,
  params: z.unknown(),
});
export type RtkRequest = z.infer<typeof requestSchema>;

export const responseSchema = z.discriminatedUnion("ok", [
  z.object({
    v: z.literal(1),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    v: z.literal(1),
    id: z.string().min(1),
    ok: z.literal(false),
    error: errorSchema,
  }),
]);
export type RtkResponse = z.infer<typeof responseSchema>;
