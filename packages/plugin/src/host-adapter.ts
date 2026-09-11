/** The only place where host parts are projected into daemon contracts. */
import type { ChatMessage, HeadroomCompressResult } from "@bluecode/contracts"
import { materializeCompaction } from "@bluecode/headroomd/pure"

export interface HostMessage {
  info: { id: string; role: string; sessionID?: string; [key: string]: unknown }
  parts: Array<{ type: string; [key: string]: any }>
  archive?: ChatMessage["archive"]
}

export function projectMessage(message: HostMessage): ChatMessage | null {
  if (!message.info?.id || !["user", "assistant"].includes(message.info.role)) return null
  // Host errors can suppress an assistant message entirely. Preserve even
  // recoverable errors in host form rather than flattening their visibility.
  let protectedContent = message.info.role === "assistant" && Boolean(message.info.error)
  const parts: ChatMessage["parts"] = []
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string") {
      if (part.ignored) protectedContent = true
      parts.push({ type: "text", text: part.text })
    } else if (part.type === "tool" && typeof part.tool === "string") {
      const state = part.state ?? {}
      if (Array.isArray(state.attachments) && state.attachments.length > 0) protectedContent = true
      const status = typeof state.status === "string" ? state.status : "pending"
      if (!["completed", "error"].includes(status)) protectedContent = true
      // Upstream substitutes compacted output, and interrupted errors can expose
      // metadata.output. Neither is represented faithfully by the wire projection.
      if (status === "completed" && state.time?.compacted) protectedContent = true
      if (
        status === "error" &&
        state.metadata?.interrupted === true &&
        typeof state.metadata.output === "string"
      )
        protectedContent = true
      parts.push({
        type: "tool",
        tool: part.tool,
        ...(typeof part.callID === "string" ? { callId: part.callID } : {}),
        ...(state.input !== undefined ? { input: state.input } : {}),
        state: {
          status,
          ...(typeof state.output === "string" ? { output: state.output } : {}),
          ...(typeof state.error === "string" ? { error: state.error } : {}),
        },
      })
    } else if (!["step-start", "step-finish"].includes(part.type)) {
      // Files, reasoning, compaction, and future SDK parts retain their host form.
      protectedContent = true
    }
  }
  return {
    info: { id: message.info.id, role: message.info.role as "user" | "assistant" },
    parts,
    ...(protectedContent ? { protected: true } : {}),
    ...(message.archive ? { archive: message.archive } : {}),
  }
}

export function projectMessages(messages: readonly HostMessage[]): ChatMessage[] | null {
  const projected = messages.map(projectMessage)
  return projected.some((message) => message === null) ? null : (projected as ChatMessage[])
}

export function sessionOf(messages: readonly HostMessage[]): string | null {
  const sessions = new Set(messages.map((message) => message.info.sessionID))
  if (sessions.size !== 1) return null
  const session = [...sessions][0]
  return typeof session === "string" && session.length > 0 ? session : null
}

export function upstreamEpoch(messages: readonly HostMessage[]): string {
  return messages
    .filter((m) => m.info.summary === true || m.parts.some((p) => p.type === "compaction"))
    .map((m) =>
      JSON.stringify([
        m.info.id,
        m.info.parentID,
        m.info.summary,
        m.parts.filter((p) => p.type === "compaction"),
      ])
    )
    .join("|")
}

export function applyHostView(
  messages: HostMessage[],
  plan: HeadroomCompressResult
): "applied" | "already-compacted" | "invalid" | "no-match" {
  const projection = projectMessages(messages)
  if (!projection || !plan.sourceDigests || plan.sourceDigests.length === 0) return "invalid"
  const result = materializeCompaction(projection, plan)
  if (result.status !== "applied") return result.status
  if (plan.operations) {
    const originals = new Map(messages.map((message) => [message.info.id, message]))
    const projected = new Map(projection.map((message) => [message.info.id, message]))
    // Validate every operation on a projection first. Only then construct a new
    // host array, retaining SDK metadata and opaque parts on surviving messages.
    const rebuilt = result.messages.map((message): HostMessage => {
      const original = originals.get(message.info.id)
      const before = projected.get(message.info.id)
      if (original && before) {
        const host = structuredClone(original)
        let index = 0
        for (const part of host.parts) {
          if (part.type !== "text" && part.type !== "tool") continue
          const updated = message.parts[index++]
          if (part.type === "text" && updated?.type === "text") part.text = updated.text
          else if (part.type === "tool" && updated?.type === "tool") {
            if (updated.state.output !== undefined) part.state.output = updated.state.output
            if (updated.state.error !== undefined) part.state.error = updated.state.error
          }
        }
        if (message.archive) host.archive = message.archive
        return host
      }
      const operation = plan.operations!.find((operation) => operation.kind === "range" && operation.replacement.info.id === message.info.id)
      const source = operation?.kind === "range" ? originals.get(operation.messageIds[0]!) : undefined
      if (!source) throw new Error("Validated range has no host source")
      const id = message.info.id
      return {
        info: { ...source.info, id, role: message.info.role },
        parts: message.parts.map((part, index) => ({ ...part, id: `${id}-part-${index}`, messageID: id,
          sessionID: source.info.sessionID, synthetic: true })),
        ...(message.archive ? { archive: message.archive } : {}),
      }
    })
    messages.splice(0, messages.length, ...rebuilt)
    return "applied"
  }
  const start = messages.findIndex((message) => message.info.id === plan.replacedMessageIds[0])
  // Plans can replace only the stable oldest prefix. Never discard an intervening host part.
  if (start !== 0) return "invalid"
  const replacement = result.messages[0]!
  const source = messages[0]!
  const id = replacement.info.id
  const hostReplacement: HostMessage = {
    info: { ...source.info, id, role: "user" },
    parts: replacement.parts.map((part, index) => ({
      ...part,
      id: `${id}-part-${index}`,
      messageID: id,
      sessionID: source.info.sessionID,
      synthetic: true,
    })),
    ...(replacement.archive ? { archive: replacement.archive } : {}),
  }
  messages.splice(0, plan.replacedMessageIds.length, hostReplacement)
  return "applied"
}
