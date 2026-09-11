/** Host-safe API: no daemon startup or SQLite imports. */
export { COMPACTION_MARKER, contentHash, contentDigest, splitTurns, historyHash } from "./turns"
export {
  buildReplacementMessage,
  buildReplacementText,
  materializeCompaction,
  type CompactionPlan,
  type MaterializedCompaction,
  type CompactionApplyStatus,
} from "./compaction"
export { buildMemory, renderMemory } from "./memory"
export { materializeOperations, textDigest } from "./layered-operations"
export { buildLayeredPlan, createLayeredCache, layeredMessageTokens, nodeContentHash, LAYERED_POLICY_VERSION, type LayeredPlan, type LayeredPlanOptions, type LayeredCache } from "./layered"
export { createCachedTokenCounter, estimatedTokenCounter, type TokenCounter } from "./token-counter"
