/**
 * headroomd protocol v1 — schemas and inferred types only (no runtime logic).
 *
 * Key design decision: this module deliberately does NOT import any opencode
 * type. Messages cross the boundary as a minimal structured projection (the
 * plugin owns the mapping), keeping contracts decoupled from the upstream
 * snapshot that gets refreshed periodically.
 */
import { z } from "zod";
import { sha256RefSchema } from "./rtk";

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

export const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });
export const toolPartSchema = z.object({
  type: z.literal("tool"),
  tool: z.string(),
  state: z.object({
    status: z.string(),
    output: z.string().optional(),
  }),
});
export const partSchema = z.union([textPartSchema, toolPartSchema]);

export const chatMessageSchema = z.object({
  info: z.object({ id: z.string(), role: z.enum(["user", "assistant"]) }),
  parts: z.array(partSchema),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

export const headroomCompressParamsSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  messages: z.array(chatMessageSchema),
  contextWindowTokens: z.number(),
  /** Compaction trigger watermark; applied by headroomd as 0.7 when omitted. */
  triggerRatio: z.number().default(0.7),
  /** Recent turns kept verbatim; applied by headroomd as 4 when omitted. */
  retainRecentTurns: z.number().int().nonnegative().default(4),
});
/** Wire shape (what the plugin sends); defaults still optional here. */
export type HeadroomCompressParams = z.input<typeof headroomCompressParamsSchema>;
/** Parsed shape; defaults materialized. */
export type HeadroomCompressParamsParsed = z.output<typeof headroomCompressParamsSchema>;

export const compactionRefSchema = z.object({
  contentHash: z.string(),
  role: z.enum(["user", "assistant"]),
  turnIndex: z.number(),
});

export const headroomCompressResultSchema = z
  .object({
    compacted: z.boolean(),
    historyHash: z.string().nullable(),
    summary: z.string().nullable(),
    refs: z.array(compactionRefSchema),
    rawTokens: z.number(),
    summaryTokens: z.number(),
    freedTokens: z.number(),
  })
  // Invariant: when nothing was compacted the result is fully inert —
  // historyHash/summary are null, freedTokens is 0 and refs is empty.
  .refine(
    (r) =>
      r.compacted ||
      (r.historyHash === null &&
        r.summary === null &&
        r.freedTokens === 0 &&
        r.refs.length === 0),
    {
      message:
        "compacted=false requires historyHash=null, summary=null, freedTokens=0 and refs=[]",
    },
  );
export type HeadroomCompressResult = z.infer<typeof headroomCompressResultSchema>;

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

export const namespaceSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
});
export type Namespace = z.infer<typeof namespaceSchema>;

/** Retrieve by hash: fetch the full original content stored under `hash`. */
export const retrieveByHashParamsSchema = z.strictObject({
  namespace: namespaceSchema,
  hash: sha256RefSchema,
});
export type RetrieveByHashParams = z.infer<typeof retrieveByHashParamsSchema>;

/** Retrieve by query: BM25 search, limit applied by headroomd as 5 when omitted. */
export const retrieveByQueryParamsSchema = z.strictObject({
  namespace: namespaceSchema,
  query: z.string(),
  limit: z.number().int().positive().default(5),
});
export type RetrieveByQueryParams = z.input<typeof retrieveByQueryParamsSchema>;
export type RetrieveByQueryParamsParsed = z.output<typeof retrieveByQueryParamsSchema>;

/**
 * The two retrieve modes share no literal discriminator field, so a plain
 * union of strict members is used instead of z.discriminatedUnion: strictness
 * makes the match exclusive (an object carrying both `hash` and `query`, or
 * neither, fails both branches -> caller answers E_INVALID_PARAMS).
 */
export const headroomRetrieveParamsSchema = z.union([
  retrieveByHashParamsSchema,
  retrieveByQueryParamsSchema,
]);
export type HeadroomRetrieveParams = z.input<typeof headroomRetrieveParamsSchema>;

export const retrieveByHashResultSchema = z.object({
  found: z.boolean(),
  content: z.string().optional(),
});
export type RetrieveByHashResult = z.infer<typeof retrieveByHashResultSchema>;

export const retrieveHitSchema = z.object({
  score: z.number(),
  hash: z.string(),
  projectId: z.string(),
  sessionId: z.string(),
  turnIndex: z.number(),
  role: z.enum(["user", "assistant"]),
  snippet: z.string(),
});
export type RetrieveHit = z.infer<typeof retrieveHitSchema>;

export const retrieveByQueryResultSchema = z.object({
  hits: z.array(retrieveHitSchema),
});
export type RetrieveByQueryResult = z.infer<typeof retrieveByQueryResultSchema>;

export const headroomRetrieveResultSchema = z.union([
  retrieveByHashResultSchema,
  retrieveByQueryResultSchema,
]);
export type HeadroomRetrieveResult = z.infer<typeof headroomRetrieveResultSchema>;

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

export const healthParamsSchema = z.object({});
export const healthResultSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int().positive(),
  uptimeMs: z.number(),
  sessions: z.number(),
});
export type HealthResult = z.infer<typeof healthResultSchema>;
