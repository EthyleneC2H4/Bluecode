/**
 * Content-addressed per-message objects. One message = one object whose
 * content is gzip(JSON projection {info, parts}); the path reuses the shared
 * CAS layout so tooling can inspect stores uniformly.
 *
 * Attribution metadata (project/session/turn) lives in the cas_meta TABLE,
 * never inside the object body — replayed/rewritten metadata must never
 * override what an object originally was (the blue/ postmortem's
 * "first metadata wins forever" trap).
 */
import { gunzipSync } from "node:zlib";
import type { ChatMessage } from "@bluecode/contracts";
import { readObject, writeObject } from "@bluecode/shared";

export interface MessageProjection {
  info: ChatMessage["info"];
  parts: ChatMessage["parts"];
}

/** Persist one message; returns its content hash (sha256 hex, no prefix). */
export async function writeMessageObject(
  dataDir: string,
  message: ChatMessage,
): Promise<{ hash: string; existed: boolean }> {
  const projection: MessageProjection = { info: message.info, parts: message.parts };
  const compressed = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(projection)));
  const stored = await writeObject(dataDir, compressed);
  return { hash: stored.hash, existed: stored.existed };
}

/** Read one message back; null when absent. */
export async function readMessageObject(
  dataDir: string,
  hash: string,
): Promise<MessageProjection | null> {
  const bytes = await readObject(dataDir, hash);
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
