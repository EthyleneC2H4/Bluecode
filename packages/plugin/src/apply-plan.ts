/**
 * applyPlanInPlace — mutate the messages array in place by replacing the
 * compressed message range with a single synthetic user message.
 *
 * This is the ONLY place that performs the replacement. The daemon returns
 * `replacedMessageIds` as the single source of truth for which messages were
 * covered by the compression; the plugin MUST NOT re-derive turn segmentation.
 */
import type { ChatMessage } from "@bluecode/contracts";
import { COMPACTION_MARKER } from "@bluecode/headroomd";

export interface CompactionPlan {
  refs: Array<{ contentHash: string; role: "user" | "assistant"; turnIndex: number }>;
  summary: string | null;
  replacedMessageIds: string[];
  historyHash: string | null;
}

/**
 * Check if a message is already a compaction replacement.
 */
function isCompactionReplacement(message: ChatMessage): boolean {
  if (message.info.role !== "user") return false;
  for (const part of message.parts) {
    if (part.type === "text" && part.text.startsWith(COMPACTION_MARKER)) return true;
  }
  return false;
}

/**
 * Apply a compaction plan to the messages array in place.
 *
 * - Locates messages by `replacedMessageIds` in the input array
 * - Splices them out and inserts a single synthetic user message
 * - The synthetic message text starts with COMPACTION_MARKER
 * - Idempotent: if the plan has already been applied (detected by marker),
 *   subsequent calls are no-ops.
 * - Safe: missing message IDs are skipped without error.
 *
 * @param messages The messages array to mutate (same reference must be preserved)
 * @param plan The compaction plan from headroomd compress result
 * @returns true if a replacement was made, false if no-op (already applied or nothing to do)
 */
export function applyPlanInPlace(messages: ChatMessage[], plan: CompactionPlan): boolean {
  if (plan.replacedMessageIds.length === 0) return false;

  // Find the indices of messages to replace
  const indices: number[] = [];
  for (const id of plan.replacedMessageIds) {
    const idx = messages.findIndex((m) => m.info.id === id);
    if (idx !== -1) indices.push(idx);
  }

  if (indices.length === 0) return false;

  // Check idempotency: if the first message to be replaced is already a compaction marker, no-op
  const firstIdx = indices[0];
  if (firstIdx === undefined) return false;
  // firstIdx came from findIndex over this same array, so the element exists.
  if (isCompactionReplacement(messages[firstIdx]!)) {
    return false;
  }

  // Sort indices descending so we can splice from highest to lowest without index shifting
  indices.sort((a, b) => b - a);

  // Build the replacement message content
  const refsText = plan.refs.length > 0
    ? "\n\n**Original turns (by hash):**\n" +
      plan.refs.map((r) => `- turn ${r.turnIndex} (${r.role}): \`${r.contentHash}\``).join("\n")
    : "";

  const summaryText = plan.summary ? `\n\n**Summary:**\n${plan.summary}` : "";

  const retrieveHint = plan.historyHash
    ? `\n\n**Retrieve full history:** Use the \`headroom_retrieve\` tool with \`hash="${plan.historyHash}"\` to fetch the complete original conversation.`
    : "";

  const replacementText = `${COMPACTION_MARKER} This conversation segment was compacted.${summaryText}${refsText}${retrieveHint}`;

  const replacementMessage: ChatMessage = {
    info: {
      id: `compaction-${plan.historyHash ?? "unknown"}-${Date.now()}`,
      role: "user",
    },
    parts: [{ type: "text", text: replacementText }],
  };

  // Remove each found message at its index (descending order preserves lower indices)
  for (const idx of indices) {
    messages.splice(idx, 1);
  }

  // Insert replacement at the position of the first (lowest) removed message.
  // indices.length >= 1 is guaranteed by the early return above.
  const insertIdx = indices[indices.length - 1]!;
  messages.splice(insertIdx, 0, replacementMessage);

  return true;
}