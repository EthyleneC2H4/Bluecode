/** Evidence-backed extractive memory. User requests stay verbatim; repetition is counted. */
import type { ChatMessage, MemoryEntry } from "@bluecode/contracts"

function compactRepetition(text: string): string {
  const spans = text.match(/.*?(?:[。！？]|[.!?](?=\s|$)|\n|$)/gs)?.filter((s) => s.trim()) ?? []
  const counts = new Map<string, number>()
  for (const span of spans) {
    const key = span.trim()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .map(([span, count]) => (count > 1 ? `${span} [repeated ${count} times]` : span))
    .join("\n")
}
function category(text: string): MemoryEntry["kind"] {
  if (/\b(fail(?:ed|ure)?|error|exception|panic)\b|失败|错误/i.test(text)) return "failures"
  if (/\b(todo|pending|next|will|unresolved)\b|待办|下一步|尚未/i.test(text)) return "open"
  if (/\b(verified|passed|success|completed)\b|验证|通过|完成/i.test(text)) return "verification"
  if (/\b(changed|updated|added|removed|fixed)\b|修改|修复|新增/i.test(text)) return "changes"
  return "decisions"
}
export function buildMemory(messages: readonly ChatMessage[]): MemoryEntry[] {
  const entries = new Map<string, MemoryEntry>()
  const add = (entry: MemoryEntry) => {
    if (!entry.text.trim()) return
    const key = `${entry.kind}\0${entry.text}`
    const previous = entries.get(key)
    if (previous) previous.sourceIds = [...new Set([...previous.sourceIds, ...entry.sourceIds])]
    else entries.set(key, { ...entry, sourceIds: [...entry.sourceIds] })
  }
  for (const message of messages) {
    if (message.archive && message.info.id === `compaction-${message.archive.historyHash}`) {
      for (const entry of message.archive.memory) add(entry)
      // Empty legacy memory cannot silently erase its visible source summary.
      if (message.archive.memory.length > 0) continue
    }
    for (const part of message.parts) {
      if (part.type === "text") {
        add({
          kind: message.info.role === "user" ? "constraints" : category(part.text),
          text: message.info.role === "user" ? part.text : compactRepetition(part.text),
          sourceIds: [message.info.id],
        })
      } else {
        const content = [
          part.input === undefined ? "" : `input: ${JSON.stringify(part.input)}`,
          part.state.output ?? "",
          part.state.error ?? "",
        ]
          .filter(Boolean)
          .join("\n")
        const text = `tool ${part.tool} (${part.state.status}): ${compactRepetition(content)}`
        add({
          kind: part.state.status === "error" ? "failures" : category(content),
          text,
          sourceIds: [message.info.id],
        })
      }
    }
  }
  return [...entries.values()]
}
export function renderMemory(memory: readonly MemoryEntry[]): string {
  const kinds: MemoryEntry["kind"][] = [
    "constraints",
    "decisions",
    "changes",
    "verification",
    "failures",
    "open",
  ]
  return kinds
    .flatMap((kind) => {
      const entries = memory.filter((entry) => entry.kind === kind)
      return entries.length
        ? [`${kind}:`, ...entries.map((entry) => `[${entry.sourceIds.join(",")}] ${entry.text}`)]
        : []
    })
    .join("\n")
}
