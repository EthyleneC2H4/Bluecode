import { memoryEntrySchema, type ChatMessage, type HeadroomCompressResult, type LayeredNode, type MemoryEntry } from "@bluecode/contracts"
import { nodeContentHash, layeredMessageTokens } from "./layered"
import { materializeOperations, textDigest } from "./layered-operations"
import { contentDigest, canonicalJSON } from "./turns"
import { estimatedTokenCounter, type TokenCounter } from "./token-counter"

/** A model may shorten optional historical notes; it never replaces pinned state or failure evidence. */
export function buildEnhancedCandidate(
  base: HeadroomCompressResult, sourceNode: LayeredNode, entries: MemoryEntry[],
  sourceMessages: readonly ChatMessage[], model: string, counter: TokenCounter = estimatedTokenCounter,
): { plan: HeadroomCompressResult; node: LayeredNode } | null {
  if (!base.compacted || !base.historyHash || !base.operations?.length || !base.budget || !base.sourceSnapshot ||
      sourceNode.children.length || sourceNode.stateEvents?.some((event) => event.kind === "failures" || event.kind === "constraints")) return null
  const sourceIds = new Set(sourceNode.sourceRefs.map((ref) => ref.messageId))
  if (!sourceIds.size || !entries.length || entries.some((entry) => !memoryEntrySchema.strict().safeParse(entry).success ||
      entry.kind === "constraints" || !entry.text.trim() || !entry.sourceIds.length || entry.sourceIds.some((id) => !sourceIds.has(id)))) return null
  const selected = base.operations.filter((operation) => operation.nodeId === sourceNode.nodeId)
  if (!selected.length || selected.some((operation) => operation.kind === "range")) return null
  const text = entries.map((entry) => `[${entry.kind}] ${entry.text} (sources: ${entry.sourceIds.join(", ")})`).join("\n")
  if (counter.count(text) > 1024) return null
  const body: Omit<LayeredNode, "nodeId"> = {
    namespace: sourceNode.namespace, level: sourceNode.level + 1, children: [sourceNode.nodeId], sourceRefs: [],
    policyVersion: `layered-summary-v1:${model}`, text, tokens: counter.count(text), sourceTokens: sourceNode.sourceTokens,
  }
  const node = { ...body, nodeId: nodeContentHash(body) }
  const ids = new Set(selected.flatMap((operation) => operation.kind === "range" ? operation.messageIds : [operation.messageId]))
  let first = true
  const operations = base.operations.map((operation) => {
    if (operation.nodeId !== sourceNode.nodeId || operation.kind === "range") return operation
    const replacement = `[headroom node:${node.nodeId}]${first ? `\n${text}` : ""}`
    first = false
    return { ...operation, nodeId: node.nodeId, replacement,
      operationId: textDigest(canonicalJSON(["summary-operation", operation.operationId, node.nodeId, replacement])) }
  })
  const messages = sourceMessages.filter((message) => ids.has(message.info.id))
  if (messages.length !== ids.size) return null
  const snapshot = { messageIds: messages.map((message) => message.info.id), sourceDigests: messages.map(contentDigest) }
  const local = (ops: typeof operations) => ops.filter((op) => op.kind === "range" ? op.messageIds.some((id) => ids.has(id)) : ids.has(op.messageId))
  const before = materializeOperations(messages, local(base.operations), snapshot)
  const after = materializeOperations(messages, local(operations), snapshot)
  if (before.status !== "applied" || after.status !== "applied") return null
  const delta = after.messages.reduce((sum, message) => sum + layeredMessageTokens(message, counter), 0) -
    before.messages.reduce((sum, message) => sum + layeredMessageTokens(message, counter), 0)
  if (delta >= 0) return null
  const memoryTokens = Math.max(0, base.budget.memoryTokens + delta)
  if (memoryTokens > base.budget.historyBudgetTokens) return null
  const memory = [...(base.memory ?? []).filter((entry) => !entry.sourceIds.every((id) => sourceIds.has(id))), ...entries]
  const summary = memory.map((entry) => entry.text).join("\n")
  const plan: HeadroomCompressResult = {
    ...base, operations, memory, summary, summaryTokens: counter.count(summary),
    historyHash: textDigest(canonicalJSON(["enhanced-history", base.historyHash, node.nodeId, operations])),
    nodes: [...(base.nodes ?? []), node],
    replacementTokensEst: base.replacementTokensEst + delta, finalTokensEst: base.finalTokensEst + delta,
    freedTokens: base.freedTokens - delta,
    budget: { ...base.budget, memoryTokens },
    budgetExceeded: base.finalTokensEst + delta > base.budget.targetTokens,
  }
  return { plan, node }
}
