/**
 * headroomd protocol v3 — schemas and inferred types only (no runtime logic).
 *
 * Key design decision: this module deliberately does NOT import any opencode
 * type. Messages cross the boundary as a minimal structured projection (the
 * plugin owns the mapping), keeping contracts decoupled from the upstream
 * snapshot that gets refreshed periodically.
 */
import { z } from "zod"
/** v3 adds snapshot-bound atomic operations and layered evidence nodes. */
export const HEADROOM_PROTOCOL_VERSION = 3 as const

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
    .object({ historyHash: headroomHashSchema, memory: z.array(memoryEntrySchema), nodeIds: z.array(headroomHashSchema).optional(), protectedMemory: z.array(memoryEntrySchema).optional() })
    .optional(),
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

export const namespaceSchema = z.object({
  projectId: z.string(),
  sessionId: z.string(),
})
export type Namespace = z.infer<typeof namespaceSchema>

export const sourceSnapshotSchema = z.object({
  messageIds: z.array(z.string()),
  sourceDigests: z.array(headroomHashSchema),
}).refine((snapshot) => snapshot.messageIds.length === snapshot.sourceDigests.length && new Set(snapshot.messageIds).size === snapshot.messageIds.length, "invalid source snapshot")
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>

const operationBase = {
  operationId: headroomHashSchema,
  sourceVersion: z.literal(1),
  nodeId: headroomHashSchema,
}
export const viewOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...operationBase,
    kind: z.literal("range"),
    messageIds: z.array(z.string()).min(1),
    sourceDigests: z.array(headroomHashSchema).min(1),
    replacement: chatMessageSchema,
  }),
  z.object({
    ...operationBase,
    kind: z.literal("tool-output"),
    messageId: z.string(),
    sourceDigest: headroomHashSchema,
    partIndex: z.number().int().nonnegative(),
    outputDigest: headroomHashSchema,
    replacement: z.string(),
  }),
  z.object({
    ...operationBase,
    kind: z.literal("text-range"),
    messageId: z.string(),
    sourceDigest: headroomHashSchema,
    partIndex: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    textDigest: headroomHashSchema,
    replacement: z.string(),
  }),
]).refine((operation) => operation.kind === "text-range" ? operation.end > operation.start : operation.kind === "range" ? operation.messageIds.length === operation.sourceDigests.length && new Set(operation.messageIds).size === operation.messageIds.length : true, "invalid operation range")
export type ViewOperation = z.infer<typeof viewOperationSchema>

export const layeredSourceRefSchema = z.object({
  messageId: z.string(),
  contentHash: headroomHashSchema,
  partIndex: z.number().int().nonnegative().optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  historyHash: headroomHashSchema.optional(),
  nodeId: headroomHashSchema.optional(),
})
export type LayeredSourceRef = z.infer<typeof layeredSourceRefSchema>
/** Append-only source-bound task events. A successful different command never resolves a failure. */
export const layeredStateEventSchema = memoryEntrySchema.extend({
  eventId: headroomHashSchema,
  sourceDigests: z.array(headroomHashSchema),
  order: z.number().int().nonnegative(),
  tool: z.string().optional(),
  inputDigest: headroomHashSchema.optional(),
  outputDigest: headroomHashSchema.optional(),
  status: z.string().optional(),
})
export type LayeredStateEvent = z.infer<typeof layeredStateEventSchema>

export const layeredNodeSchema = z.object({
  nodeId: headroomHashSchema,
  namespace: namespaceSchema,
  level: z.number().int().nonnegative(),
  children: z.array(headroomHashSchema),
  sourceRefs: z.array(layeredSourceRefSchema),
  /** Original immutable task events, bounded per leaf. Parents retain only child references. */
  stateEvents: z.array(layeredStateEventSchema).max(64).optional(),
  policyVersion: z.string(),
  text: z.string(),
  tokens: z.number().int().nonnegative(),
  sourceTokens: z.number().int().nonnegative(),
}).refine((node) => {
  if (!node.stateEvents) return true
  if (node.level !== 0 || node.children.length !== 0) return false
  const sources = new Map(node.sourceRefs.map((ref) => [ref.messageId, ref.contentHash]))
  return new Set(node.stateEvents.map((event) => event.eventId)).size === node.stateEvents.length && node.stateEvents.every((event) => event.sourceIds.length > 0 && event.sourceIds.length === event.sourceDigests.length && event.sourceIds.every((id, index) => sources.get(id) === event.sourceDigests[index]))
}, "invalid leaf state provenance")
export type LayeredNode = z.infer<typeof layeredNodeSchema>
export const layeredBudgetSchema = z.object({
  availableInputTokens: z.number().nonnegative(),
  targetTokens: z.number().nonnegative(),
  protectedTokens: z.number().nonnegative(),
  recentTokens: z.number().nonnegative(),
  wrapperTokens: z.number().nonnegative(),
  historyBudgetTokens: z.number().nonnegative(),
  memoryTokens: z.number().nonnegative(),
  reasons: z.array(z.string()),
})
export type LayeredBudget = z.infer<typeof layeredBudgetSchema>
export const layeredMetricsSchema = z.object({
  queueMs: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  cpuUserMicros: z.number().nonnegative().optional(),
  cpuSystemMicros: z.number().nonnegative().optional(),
  rssBytes: z.number().nonnegative().optional(),
  scannedMessages: z.number().int().nonnegative(),
  analyzedMessages: z.number().int().nonnegative(),
  analysisCacheHits: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  selectedMemoryBlocks: z.number().int().nonnegative(),
  deduplicatedObservations: z.number().int().nonnegative(),
  operationCount: z.number().int().nonnegative(),
  leafNodes: z.number().int().nonnegative(),
  parentNodes: z.number().int().nonnegative(),
  tokenCounter: z.string(),
  tokenCountMode: z.enum(["estimated", "tokenizer"]),
})
export type LayeredMetrics = z.infer<typeof layeredMetricsSchema>

export const layeredTaskStateSchema = z.object({
  events: z.array(layeredStateEventSchema),
  currentRequestIds: z.array(z.string()),
})
export type LayeredTaskState = z.infer<typeof layeredTaskStateSchema>

export const summaryProviderSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  endpoint: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().max(8192).optional(),
  maxOutputTokens: z.number().int().positive().max(1024).optional(),
  sessionInputTokens: z.number().int().positive().max(32768).optional(),
  sessionOutputTokens: z.number().int().positive().max(4096).optional(),
})
export type SummaryProviderConfig = z.infer<typeof summaryProviderSchema>


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
  strategy: z.enum(["legacy", "layered"]).optional(),
  memoryMaxTokens: z.number().int().nonnegative().optional(),
  memoryRatio: z.number().min(0).max(1).optional(),
  summaryProvider: summaryProviderSchema.optional(),
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

function operationSourcesAligned(plan: { compacted: boolean; operations?: ViewOperation[] | undefined; sourceSnapshot?: SourceSnapshot | undefined; replacedMessageIds: string[]; sourceDigests?: string[] | undefined }): boolean {
  if (plan.operations === undefined) return true // Legacy single-range plan.
  if (!plan.compacted) return plan.operations.length === 0
  if (!plan.operations.length || !plan.sourceSnapshot) return false
  const snapshot = new Map(plan.sourceSnapshot.messageIds.map((id, index) => [id, { index, digest: plan.sourceSnapshot!.sourceDigests[index] }]))
  const touched = new Set<string>(), operationIds = new Set<string>()
  const spans = new Map<string, Array<{ start: number; end: number }>>()
  const whole = new Set<string>()
  for (const operation of plan.operations) {
    if (operationIds.has(operation.operationId)) return false
    operationIds.add(operation.operationId)
    const ids = operation.kind === "range" ? operation.messageIds : [operation.messageId]
    const digests = operation.kind === "range" ? operation.sourceDigests : [operation.sourceDigest]
    for (let i = 0; i < ids.length; i++) {
      const source = snapshot.get(ids[i]!)
      if (!source || source.digest !== digests[i]) return false
      if (operation.kind === "range" && source.index !== snapshot.get(ids[0]!)!.index + i) return false
      touched.add(ids[i]!)
      if (operation.kind === "range") {
        if (whole.has(ids[i]!)) return false
        whole.add(ids[i]!)
      }
    }
    if (operation.kind !== "range") {
      const key = JSON.stringify([operation.messageId, operation.partIndex])
      const list = spans.get(key) ?? []
      list.push(operation.kind === "tool-output" ? { start: 0, end: Infinity } : { start: operation.start, end: operation.end })
      spans.set(key, list)
    }
  }
  for (const operation of plan.operations) if (operation.kind !== "range" && whole.has(operation.messageId)) return false
  for (const list of spans.values()) {
    list.sort((a, b) => a.start - b.start)
    for (let i = 1; i < list.length; i++) if (list[i - 1]!.end > list[i]!.start) return false
  }
  const ordered = plan.sourceSnapshot.messageIds.filter((id) => touched.has(id))
  return ordered.length === plan.replacedMessageIds.length && ordered.every((id, index) => id === plan.replacedMessageIds[index] && snapshot.get(id)!.digest === plan.sourceDigests?.[index])
}

export const headroomCompressResultSchema = z
  .object({
    compacted: z.boolean(),
    strategy: z.enum(["legacy", "layered"]).optional(),
    operations: z.array(viewOperationSchema).optional(),
    nodes: z.array(layeredNodeSchema).optional(),
    protectedMemory: z.array(memoryEntrySchema).optional(),
    taskState: layeredTaskStateSchema.optional(),
    sourceSnapshot: sourceSnapshotSchema.optional(),
    budget: layeredBudgetSchema.optional(),
    metrics: layeredMetricsSchema.optional(),
    enhancementJobId: z.string().optional(),
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
      operationSourcesAligned(r) &&
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

export const getCandidateParamsSchema = z.object({
  namespace: namespaceSchema,
  jobId: z.string(),
  epoch: z.string().optional(),
  sourceDigests: z.array(headroomHashSchema).optional(),
})
export type GetCandidateParams = z.infer<typeof getCandidateParamsSchema>
export const getCandidateResultSchema = z.object({
  status: z.enum(["queued", "running", "ready", "rejected", "missing"]),
  candidate: headroomCompressResultSchema.nullable(),
  reason: z.string().optional(),
})
export type GetCandidateResult = z.infer<typeof getCandidateResultSchema>

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------


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
  style: z.enum(["cards", "segments"]).optional(),
  // Protocol hygiene cap: one unbounded query could dump the whole archive
  // into model context (each hit carries a snippet). The plugin tool CLAMPS
  // to this cap instead of mirroring it, so LLM callers see truncation rather
  // than E_INVALID_PARAMS; direct UDS clients get the strict rejection.
  limit: z.number().int().positive().max(50).default(5),
})
export type RetrieveByQueryParams = z.input<typeof retrieveByQueryParamsSchema>
export type RetrieveByQueryParamsParsed = z.output<typeof retrieveByQueryParamsSchema>

export const retrieveByNodeParamsSchema = z.strictObject({
  namespace: namespaceSchema,
  nodeId: headroomHashSchema,
  detail: z.enum(["summary", "children", "source"]).optional(),
  depth: z.number().int().nonnegative().max(20).optional(),
  cursor: z.string().optional(),
  maxBytes: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
})
export type RetrieveByNodeParams = z.infer<typeof retrieveByNodeParamsSchema>

/**
 * The four retrieve modes share no literal discriminator field, so a plain
 * union of strict members is used instead of z.discriminatedUnion: strictness
 * makes the match exclusive (an object carrying both `hash` and `query`, or
 * neither, fails both branches -> caller answers E_INVALID_PARAMS).
 */
export const headroomRetrieveParamsSchema = z.union([
  retrieveByHashParamsSchema,
  retrieveByHistoryParamsSchema,
  retrieveByQueryParamsSchema,
  retrieveByNodeParamsSchema,
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
  filePaths: z.array(z.string()).optional(),
  identifiers: z.array(z.string()).optional(),
  nodeIds: z.array(headroomHashSchema).optional(),
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

export const retrieveByNodeResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    node: z.object({ nodeId: headroomHashSchema, level: z.number().int().nonnegative(), policyVersion: z.string(), tokens: z.number().int().nonnegative(), sourceTokens: z.number().int().nonnegative() }),
    content: z.string(),
    children: z.array(z.object({ nodeId: headroomHashSchema, level: z.number().int().nonnegative(), tokens: z.number().int().nonnegative() })).optional(),
    sourceRefs: z.array(layeredSourceRefSchema).optional(),
    sourceItems: z.array(retrieveByHistoryItemSchema).optional(),
    nextCursor: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
  }),
])
export type RetrieveByNodeResult = z.infer<typeof retrieveByNodeResultSchema>

export const headroomRetrieveResultSchema = z.union([
  retrieveByHashResultSchema,
  retrieveByHistoryResultSchema,
  retrieveByQueryResultSchema,
  retrieveByNodeResultSchema,
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
  "getCandidate",
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
