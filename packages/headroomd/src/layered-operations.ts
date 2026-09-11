/** Atomic view edits over a host snapshot. No mutation, storage, or provider imports. */
import { createHash } from "node:crypto"
import { viewOperationSchema, type ChatMessage, type SourceSnapshot, type ViewOperation } from "@bluecode/contracts"
import { contentDigest } from "./turns"
import type { MaterializedCompaction } from "./compaction"

export const COMPLETED_TOOL_STATUSES = new Set(["completed", "error", "ok", "success", "failed"])
export function textDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** Validate against the original snapshot once, then publish all edits together. */
export function materializeOperations(
  messages: readonly ChatMessage[],
  operations: readonly ViewOperation[],
  snapshot?: SourceSnapshot
): MaterializedCompaction {
  const fail = (status: MaterializedCompaction["status"] = "invalid"): MaterializedCompaction => ({ status, messages: [...messages] })
  if (!operations.length || !snapshot) return fail()
  const byId = new Map<string, number>()
  const digests = new Map<number, string>()
  for (let i = 0; i < messages.length; i++) {
    if (byId.has(messages[i]!.info.id)) return fail()
    byId.set(messages[i]!.info.id, i)
  }
  if (snapshot) {
    if (snapshot.messageIds.length !== snapshot.sourceDigests.length || new Set(snapshot.messageIds).size !== snapshot.messageIds.length) return fail()
    for (let i = 0; i < snapshot.messageIds.length; i++) {
      if (messages[i]?.info.id !== snapshot.messageIds[i]) return fail()
      const digest = contentDigest(messages[i]!)
      if (digest !== snapshot.sourceDigests[i]) return fail()
      digests.set(i, digest)
    }
  }
  // An operation may only touch sources inside the validated prefix. A digest
  // of an appended message does not make that message part of this snapshot.
  const matches = (index: number, digest: string): boolean => digests.get(index) === digest
  const ranges: Array<{ start: number; end: number; replacement: ChatMessage }> = []
  const parts = new Map<number, Map<number, Array<Extract<ViewOperation, { kind: "tool-output" | "text-range" }>>>>()
  const whole = new Set<number>()
  const operationIds = new Set<string>()
  for (const operation of operations) {
    if (!viewOperationSchema.safeParse(operation).success || operationIds.has(operation.operationId)) return fail()
    operationIds.add(operation.operationId)
    if (operation.kind === "range") {
      if (operation.messageIds.length !== operation.sourceDigests.length || new Set(operation.messageIds).size !== operation.messageIds.length) return fail()
      const start = byId.get(operation.messageIds[0]!)
      if (start === undefined) return fail("no-match")
      for (let i = 0; i < operation.messageIds.length; i++) {
        const index = start + i
        const message = messages[index]
        if (!message || message.info.id !== operation.messageIds[i] || message.protected || whole.has(index) || parts.has(index) || !matches(index, operation.sourceDigests[i]!)) return fail()
        if (message.parts.some((part) => part.type !== "text" && (part.type !== "tool" || !COMPLETED_TOOL_STATUSES.has(part.state.status)))) return fail()
        whole.add(index)
      }
      const replacementIndex = byId.get(operation.replacement.info.id)
      if (replacementIndex !== undefined && (replacementIndex < start || replacementIndex >= start + operation.messageIds.length)) return fail()
      ranges.push({ start, end: start + operation.messageIds.length, replacement: operation.replacement })
      continue
    }
    const index = byId.get(operation.messageId)
    if (index === undefined) return fail("no-match")
    const message = messages[index]!
    if (message.protected || whole.has(index) || !matches(index, operation.sourceDigest)) return fail()
    const part = message.parts[operation.partIndex]
    if (operation.kind === "tool-output") {
      if (!part || part.type !== "tool" || !COMPLETED_TOOL_STATUSES.has(part.state.status) || textDigest(part.state.output ?? "") !== operation.outputDigest) return fail()
    } else {
      if (!part || part.type !== "text" || operation.end <= operation.start || operation.end > part.text.length || textDigest(part.text.slice(operation.start, operation.end)) !== operation.textDigest) return fail()
    }
    let messageParts = parts.get(index)
    if (!messageParts) { messageParts = new Map(); parts.set(index, messageParts) }
    const edits = messageParts.get(operation.partIndex) ?? []
    edits.push(operation)
    messageParts.set(operation.partIndex, edits)
  }
  // Sort once per edited part. Whole-message and partial-operation conflicts were checked above.
  for (const messageParts of parts.values()) {
    for (const edits of messageParts.values()) {
      edits.sort((a, b) => (a.kind === "text-range" ? a.start : 0) - (b.kind === "text-range" ? b.start : 0))
      for (let i = 1; i < edits.length; i++) {
        const previous = edits[i - 1]!, current = edits[i]!
        if (previous.kind !== "text-range" || current.kind !== "text-range" || previous.end > current.start) return fail()
      }
    }
  }
  const next = [...messages]
  for (const [index, messageParts] of parts) {
    const message = messages[index]!
    const nextParts = [...message.parts]
    for (const [partIndex, edits] of messageParts) {
      const part = message.parts[partIndex]!
      const first = edits[0]!
      if (first.kind === "tool-output" && part.type === "tool") {
        nextParts[partIndex] = { ...part, state: { ...part.state, output: first.replacement } }
      } else if (part.type === "text") {
        let end = 0
        const chunks: string[] = []
        for (const edit of edits) {
          if (edit.kind !== "text-range") return fail()
          chunks.push(part.text.slice(end, edit.start), edit.replacement)
          end = edit.end
        }
        chunks.push(part.text.slice(end))
        nextParts[partIndex] = { ...part, text: chunks.join("") }
      }
    }
    next[index] = { ...message, parts: nextParts }
  }
  // Descending splice would be quadratic for many disjoint ranges. Stream them instead.
  ranges.sort((a, b) => a.start - b.start)
  const output: ChatMessage[] = []
  let cursor = 0
  for (const range of ranges) {
    for (; cursor < range.start; cursor++) output.push(next[cursor]!)
    output.push(structuredClone(range.replacement))
    cursor = range.end
  }
  for (; cursor < next.length; cursor++) output.push(next[cursor]!)
  if (new Set(output.map((message) => message.info.id)).size !== output.length) return fail()
  return { status: "applied", messages: output }
}
