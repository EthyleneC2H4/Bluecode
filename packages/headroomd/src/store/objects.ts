/**
 * Per-message objects under their LOGICAL content address. One message = one
 * object whose body is gzip(JSON projection {info, parts}); the address is
 * the message's contentHash over the canonical projection (turns.ts) — NOT a
 * digest of the gzip bytes — so refs/cas_meta/retrieve all speak one hash
 * namespace and the object is reachable from any of them. Integrity of the
 * decoded body rests on gzip CRC + JSON.parse instead of a byte digest.
 *
 * Attribution metadata (project/session/turn) lives in the cas_meta TABLE,
 * never inside the object body — replayed/rewritten metadata must never
 * override what an object originally was (the blue/ postmortem's
 * "first metadata wins forever" trap).
 */
import { gunzipSync } from "node:zlib"
import { chatMessageSchema, type ChatMessage } from "@bluecode/contracts"
import { contentDigest, legacyContentHash } from "../turns"
import { readObjectAs, writeObjectAs } from "@bluecode/shared"

export type MessageProjection = ChatMessage

/**
 * Persist one message under `contentHash` (the canonical-projection hash
 * computed in turns.ts). Dedup hits when that exact message is already
 * stored.
 */
export async function writeMessageObject(
  dataDir: string,
  message: ChatMessage,
  contentHash: string
): Promise<{ hash: string; existed: boolean }> {
  const projection = chatMessageSchema.parse(message)
  if (contentDigest(projection) !== contentHash)
    throw new Error("Message content hash mismatch before write")
  const compressed = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(projection)))
  return writeObjectAs(dataDir, contentHash, compressed)
}

/** Read one message back by its logical hash; null when absent. */
export async function readMessageObject(
  dataDir: string,
  hash: string
): Promise<MessageProjection | null> {
  const bytes = await readObjectAs(dataDir, hash)
  if (bytes === null) return null
  const projection = chatMessageSchema.parse(
    JSON.parse(new TextDecoder().decode(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })))
  )
  if (contentDigest(projection) !== hash && (await legacyContentHash(projection)) !== hash)
    throw new Error("Message content hash mismatch")
  return projection
}

/**
 * Human/wire-readable rendering used for retrieve-by-hash `content`: role
 * tag, every text part verbatim, then each tool part with its full output.
 * Round-trip guarantee under test: rendering a stored message reproduces
 * everything the model could have seen in that message.
 */
export function renderProjection(projection: MessageProjection): string {
  const lines: string[] = [`[${projection.info.role}]`]
  for (const part of projection.parts) {
    if (part.type === "text") {
      lines.push(part.text)
    } else {
      const output = part.state.output ?? ""
      lines.push(`[tool:${part.tool}] ${part.state.status}`)
      if (part.input !== undefined) lines.push(JSON.stringify(part.input))
      if (output.length > 0) lines.push(output)
      if (part.state.error) lines.push(part.state.error)
    }
  }
  return lines.join("\n")
}
