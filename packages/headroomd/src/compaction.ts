import type { ChatMessage, HeadroomCompressResult } from "@bluecode/contracts"
import { COMPACTION_MARKER, isCompactionReplacement } from "./turns"

export type CompactionPlan = Pick<
  HeadroomCompressResult,
  "historyHash" | "summary" | "refs" | "replacedMessageIds"
>

export type CompactionApplyStatus =
  | "applied"
  | "no-match"
  | "invalid"
  | "already-compacted"

export interface MaterializedCompaction {
  status: CompactionApplyStatus
  messages: ChatMessage[]
}

/** Bounded model-visible replacement. Per-message refs remain machine data. */
export function buildReplacementText(plan: CompactionPlan): string {
  const summary = plan.summary === null ? "" : `\n\n摘要：\n${plan.summary}`
  const retrieve =
    plan.historyHash === null
      ? ""
      : `\n\n如需分页恢复完整历史，请调用 \`headroom_retrieve(historyHash="${plan.historyHash}")\`。`
  return `${COMPACTION_MARKER} 以下历史已归档。${summary}${retrieve}`
}

export function buildReplacementMessage(plan: CompactionPlan): ChatMessage {
  return {
    info: {
      id: `compaction-${plan.historyHash ?? "unknown"}`,
      role: "user",
    },
    parts: [{ type: "text", text: buildReplacementText(plan) }],
  }
}

/**
 * Validate and materialize a plan without mutating the caller's array.
 * The caller may atomically publish `messages` only when status is applied.
 */
export function materializeCompaction(
  messages: readonly ChatMessage[],
  plan: CompactionPlan,
): MaterializedCompaction {
  const ids = plan.replacedMessageIds
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    return { status: "invalid", messages: [...messages] }
  }

  const indexById = new Map<string, number>()
  const duplicateSourceIds = new Set<string>()
  for (let index = 0; index < messages.length; index++) {
    const id = messages[index]!.info.id
    if (indexById.has(id)) duplicateSourceIds.add(id)
    else indexById.set(id, index)
  }
  if (ids.some((id) => duplicateSourceIds.has(id))) {
    return { status: "invalid", messages: [...messages] }
  }

  const replacementId = `compaction-${plan.historyHash ?? "unknown"}`
  const indices = ids.map((id) => indexById.get(id) ?? -1)
  const missing = indices.filter((index) => index < 0).length
  if (missing === ids.length) {
    const replayed = messages.some(
      (message) => message.info.id === replacementId && isCompactionReplacement(message),
    )
    return { status: replayed ? "already-compacted" : "no-match", messages: [...messages] }
  }
  if (missing > 0) return { status: "invalid", messages: [...messages] }

  const start = indices[0] as number
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== start + i) return { status: "invalid", messages: [...messages] }
  }

  const targets = messages.slice(start, start + ids.length)
  if (targets.every(isCompactionReplacement)) {
    return { status: "already-compacted", messages: [...messages] }
  }

  const next = [...messages]
  next.splice(start, ids.length, buildReplacementMessage(plan))
  return { status: "applied", messages: next }
}
