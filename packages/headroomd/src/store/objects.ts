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
import { gunzipSync } from "node:zlib";
import type { ChatMessage } from "@bluecode/contracts";
import { readObjectAs, writeObjectAs } from "@bluecode/shared";

export interface MessageProjection {
  info: ChatMessage["info"];
  parts: ChatMessage["parts"];
}

/**
 * Persist one message under `contentHash` (the canonical-projection hash
 * computed in turns.ts). Dedup hits when that exact message is already
 * stored.
 */
export async function writeMessageObject(
  dataDir: string,
  message: ChatMessage,
  contentHash: string,
): Promise<{ hash: string; existed: boolean }> {
  const projection: MessageProjection = { info: message.info, parts: message.parts };
  const compressed = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(projection)));
  return writeObjectAs(dataDir, contentHash, compressed);
}

/** Read one message back by its logical hash; null when absent. */
export async function readMessageObject(
  dataDir: string,
  hash: string,
): Promise<MessageProjection | null> {
  const bytes = await readObjectAs(dataDir, hash);
  if (bytes === null) return null;
  return JSON.parse(new TextDecoder().decode(gunzipSync(bytes))) as MessageProjection;
}

/**
 * Human/wire-readable rendering used for retrieve-by-hash `content`: role
 * tag, every text part verbatim, then each tool part with its full output.
 * Round-trip guarantee under test: rendering a stored message reproduces
 * everything the model could have seen in that message.
 */
export function renderProjection(projection: MessageProjection): string {
  const lines: string[] = [`[${projection.info.role}]`];
  for (const part of projection.parts) {
    if (part.type === "text") {
      lines.push(part.text);
    } else {
      const output = part.state.output ?? "";
      lines.push(`[tool:${part.tool}] ${part.state.status}`);
      if (output.length > 0) lines.push(output);
    }
  }
  return lines.join("\n");
}
