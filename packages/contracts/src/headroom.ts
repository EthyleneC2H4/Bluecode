/**
 * headroomd protocol v2 — schemas and inferred types only (no runtime logic).
 *
 * Key design decision: this module deliberately does NOT import any opencode
 * type. Messages cross the boundary as a minimal structured projection (the
 * plugin owns the mapping), keeping contracts decoupled from the upstream
 * snapshot that gets refreshed periodically.
 */
import { z } from "zod"
/** v2 binds replacement plans to complete source digests. */
export const HEADROOM_PROTOCOL_VERSION = 2 as const

/**
 * Headroom hashes are BARE 64-char lowercase hex — the digest itself is the
 * address everywhere (refs, cas_meta PK, chunks.content_hash, CAS object
 * path). This deliberately differs from rtk's "sha256:"-prefixed wire form:
 * compress hands refs back to retrieve verbatim, so the wire value must be
 * byte-identical to the internal key, with no prefix to strip.
 */
export const headroomHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex chars")
import { errorSchema } from "./errors"

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

export const textPartSchema = z.object({ type: z.literal("text"), text: z.string() })
export const toolPartSchema = z.object({
  type: z.literal("tool"),
  tool: z.string(),
  callId: z.string().optional(),
  input: z.unknown().optional(),
  state: z.object({
    status: z.string(),
    error: z.string().optional(),
    output: z.string().optional(),
  }),
})
export const partSchema = z.union([textPartSchema, toolPartSchema])

export const memoryEntrySchema = z.object({
  kind: z.enum(["constraints", "decisions", "changes", "verification", "failures", "open"]),
  text: z.string(),
  sourceIds: z.array(z.string()),
})
export type MemoryEntry = z.infer<typeof memoryEntrySchema>

export const chatMessageSchema = z.object({
  info: z.object({ id: z.string(), role: z.enum(["user", "assistant"]) }),
  parts: z.array(partSchema),
  protected: z.boolean().optional(),
  archive: z
    .object({ historyHash: headroomHashSchema, memory: z.array(memoryEntrySchema) })
    .optional(),
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

export const headroomCompressParamsSchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  messages: z.array(chatMessageSchema),
  contextWindowTokens: z.number().positive(),
  targetTokens: z.number().nonnegative().optional(),
  epoch: z.string().optional(),
  protectedMessageIds: z.array(z.string()).optional(),
  /** Compaction trigger watermark; applied by headroomd as 0.7 when omitted. */
  triggerRatio: z.number().default(0.7),
  /** Recent turns kept verbatim; applied by headroomd as 4 when omitted. */
  retainRecentTurns: z.number().int().nonnegative().default(4),
})
/** Wire shape (what the plugin sends); defaults still optional here. */
export type HeadroomCompressParams = z.input<typeof headroomCompressParamsSchema>
/** Parsed shape; defaults materialized. */
export type HeadroomCompressParamsParsed = z.output<typeof headroomCompressParamsSchema>

export const compactionRefSchema = z.object({
  contentHash: headroomHashSchema,
  role: z.enum(["user", "assistant"]),
  turnIndex: z.number(),
})

export const headroomCompressResultSchema = z
  .object({
    compacted: z.boolean(),
    sourceDigests: z.array(headroomHashSchema).optional(),
    epoch: z.string().optional(),
    memory: z.array(memoryEntrySchema).optional(),
    budgetExceeded: z.boolean().optional(),
    historyHash: headroomHashSchema.nullable(),
    summary: z.string().nullable(),
    refs: z.array(compactionRefSchema),
    /**
     * `info.id` of every message covered by the compression (the turns that
     * are NOT in the retained tail), in input message order. The plugin
     * locates and replaces these messages in place via messages.transform;
     * it must not re-derive turn segmentation itself (it cannot import
     * daemon internals), so the daemon is the single source of this list.
     */
    replacedMessageIds: z.array(z.string()),
    rawTokens: z.number().nonnegative(),
    summaryTokens: z.number().nonnegative(),
    sourceTokensEst: z.number().nonnegative(),
    evictedTokensEst: z.number().nonnegative(),
    retainedTokensEst: z.number().nonnegative(),
    replacementTokensEst: z.number().nonnegative(),
    finalTokensEst: z.number().nonnegative(),
    freedTokens: z.number().nonnegative(),
  })
  // Invariant: when nothing was compacted the result is fully inert —
  // historyHash/summary are null, freedTokens is 0 and both lists are empty.
  .refine(
    (r) =>
      r.rawTokens === r.sourceTokensEst &&
      r.finalTokensEst === r.retainedTokensEst + r.replacementTokensEst &&
      r.freedTokens === r.sourceTokensEst - r.finalTokensEst &&
      (r.compacted
        ? r.sourceDigests !== undefined &&
          r.memory !== undefined &&
          r.sourceDigests.length === r.replacedMessageIds.length &&
          r.sourceDigests.length === r.refs.length &&
          r.sourceDigests.length > 0 &&
          new Set(r.replacedMessageIds).size === r.replacedMessageIds.length &&
          r.sourceDigests.every((digest, index) => digest === r.refs[index]?.contentHash) &&
          r.historyHash !== null &&
          r.summary !== null &&
          r.sourceTokensEst === r.evictedTokensEst + r.retainedTokensEst &&
          r.freedTokens > 0
        : r.historyHash === null &&
          r.summary === null &&
          r.freedTokens === 0 &&
          r.refs.length === 0 &&
          r.replacedMessageIds.length === 0 &&
          r.evictedTokensEst === 0 &&
          r.retainedTokensEst === r.sourceTokensEst &&
          r.replacementTokensEst === 0),
    {
      message: "invalid headroom token accounting or non-inert compacted=false result",
    }
  )
export type HeadroomCompressResult = z.infer<typeof headroomCompressResultSchema>

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

export const namespaceSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
})
export type Namespace = z.infer<typeof namespaceSchema>

/** Retrieve by hash: fetch the full original content stored under `hash`. */
export const retrieveByHashParamsSchema = z.strictObject({
  namespace: namespaceSchema,
  cursor: z.string().optional(),
  maxBytes: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  hash: headroomHashSchema,
})
export type RetrieveByHashParams = z.infer<typeof retrieveByHashParamsSchema>

/** Retrieve one page of an archived history in original message order. */
export const retrieveByHistoryParamsSchema = z.strictObject({
  namespace: namespaceSchema,
  cursor: z.string().optional(),
  maxBytes: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  historyHash: headroomHashSchema,
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(50).default(10),
})
export type RetrieveByHistoryParams = z.input<typeof retrieveByHistoryParamsSchema>
export type RetrieveByHistoryParamsParsed = z.output<typeof retrieveByHistoryParamsSchema>

/** Retrieve by query: BM25 search, limit applied by headroomd as 5 when omitted. */
export const retrieveByQueryParamsSchema = z.strictObject({
  namespace: namespaceSchema,
  cursor: z.string().optional(),
  maxBytes: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  query: z.string(),
  // Protocol hygiene cap: one unbounded query could dump the whole archive
  // into model context (each hit carries a snippet). The plugin tool CLAMPS
  // to this cap instead of mirroring it, so LLM callers see truncation rather
  // than E_INVALID_PARAMS; direct UDS clients get the strict rejection.
  limit: z.number().int().positive().max(50).default(5),
})
export type RetrieveByQueryParams = z.input<typeof retrieveByQueryParamsSchema>
export type RetrieveByQueryParamsParsed = z.output<typeof retrieveByQueryParamsSchema>

/**
 * The three retrieve modes share no literal discriminator field, so a plain
 * union of strict members is used instead of z.discriminatedUnion: strictness
 * makes the match exclusive (an object carrying both `hash` and `query`, or
 * neither, fails both branches -> caller answers E_INVALID_PARAMS).
 */
export const headroomRetrieveParamsSchema = z.union([
  retrieveByHashParamsSchema,
  retrieveByHistoryParamsSchema,
  retrieveByQueryParamsSchema,
])
export type HeadroomRetrieveParams = z.input<typeof headroomRetrieveParamsSchema>

/**
 * Discriminated union so `found:true` REQUIRES `content` (a Task 2 review
 * finding: the loose `{found:boolean, content?}` shape let a found-hit omit
 * its payload). `found:false` carries no content by construction.
 */
export const retrieveByHashResultSchema = z.discriminatedUnion("found", [
  z.object({
    found: z.literal(true),
    content: z.string(),
    nextCursor: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({ found: z.literal(false) }),
])
export type RetrieveByHashResult = z.infer<typeof retrieveByHashResultSchema>

export const retrieveByHistoryItemSchema = z.object({
  contentHash: headroomHashSchema,
  role: z.enum(["user", "assistant"]),
  turnIndex: z.number().int().nonnegative(),
  content: z.string(),
})

export const retrieveByHistoryResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    items: z.array(retrieveByHistoryItemSchema),
    nextCursor: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
    nextOffset: z.number().int().nonnegative().nullable(),
    partial: z.boolean(),
    missingHashes: z.array(headroomHashSchema),
  }),
])
export type RetrieveByHistoryResult = z.infer<typeof retrieveByHistoryResultSchema>

export const retrieveHitSchema = z.object({
  score: z.number(),
  hash: z.string(),
  projectId: z.string(),
  sessionId: z.string(),
  turnIndex: z.number(),
  role: z.enum(["user", "assistant"]),
  snippet: z.string(),
  chunkId: z.string().optional(),
  startOffset: z.number().optional(),
  endOffset: z.number().optional(),
})
export type RetrieveHit = z.infer<typeof retrieveHitSchema>

export const retrieveByQueryResultSchema = z.object({
  hits: z.array(retrieveHitSchema),
  nextCursor: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
})
export type RetrieveByQueryResult = z.infer<typeof retrieveByQueryResultSchema>

export const headroomRetrieveResultSchema = z.union([
  retrieveByHashResultSchema,
  retrieveByHistoryResultSchema,
  retrieveByQueryResultSchema,
])
export type HeadroomRetrieveResult = z.infer<typeof headroomRetrieveResultSchema>

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

export const healthParamsSchema = z.object({})
export const healthResultSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int().positive(),
  uptimeMs: z.number(),
  sessions: z.number(),
})
export type HealthResult = z.infer<typeof healthResultSchema>

// ---------------------------------------------------------------------------
// Envelopes — mirror rtk.ts conventions (errors.ts owns the code mapping)
// ---------------------------------------------------------------------------

export const headroomOpSchema = z.enum([
  "compress",
  "retrieve",
  "health",
  "view.get",
  "view.set",
  "view.clear",
])
export type HeadroomOp = z.infer<typeof headroomOpSchema>

export const headroomRequestSchema = z.object({
  v: z.literal(HEADROOM_PROTOCOL_VERSION),
  id: z.string().min(1),
  op: headroomOpSchema,
  params: z.unknown(),
})
export type HeadroomRequest = z.infer<typeof headroomRequestSchema>

export const headroomResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    v: z.literal(HEADROOM_PROTOCOL_VERSION),
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    v: z.literal(HEADROOM_PROTOCOL_VERSION),
    id: z.string().min(1),
    ok: z.literal(false),
    error: errorSchema,
  }),
])
export type HeadroomResponse = z.infer<typeof headroomResponseSchema>
