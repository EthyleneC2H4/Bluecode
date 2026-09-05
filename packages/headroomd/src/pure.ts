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
