/** Atomic plugin adapter over headroomd's pure compaction materializer. */
import type { ChatMessage } from "@bluecode/contracts"
import {
  materializeCompaction,
  type CompactionApplyStatus,
  type CompactionPlan,
} from "@bluecode/headroomd"

export type { CompactionApplyStatus, CompactionPlan }

/**
 * Validate and apply a plan while preserving the host array reference.
 * Invalid, unmatched and replayed plans leave every element untouched.
 */
export function applyPlanInPlace(
  messages: ChatMessage[],
  plan: CompactionPlan,
): CompactionApplyStatus {
  const materialized = materializeCompaction(messages, plan)
  if (materialized.status === "applied") {
    messages.splice(0, messages.length, ...materialized.messages)
  }
  return materialized.status
}
