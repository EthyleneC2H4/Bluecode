/**
 * Turn segmentation and the two-level hash scheme (per-message contentHash,
 * whole-history historyHash). Pure functions over the wire message
 * projection — no I/O, no clocks, fully deterministic (eval depends on it).
 *
 * Turn rule (matches upstream compaction semantics): a role=user message
 * starts a new turn, which lasts until the next user message. A compaction
 * replacement message (`[bluecode 历史压缩]` prefix) is itself a user
 * message, so it opens its own turn — and it hashes like any other message:
 * its visible summary text IS the real history now.
 */
import { sha256Hex } from "@bluecode/shared";
import type { ChatMessage } from "@bluecode/contracts";

type Part = ChatMessage["parts"][number];

/** Prefix identifying a synthetic replacement message produced by the plugin. */
export const COMPACTION_MARKER = "[bluecode 历史压缩]";

export interface Turn {
  /** 0-based turn ordinal within the input array. */
  index: number;
  /** `info.id` of the messages in this turn, in order. */
  messageIds: string[];
  messages: ChatMessage[];
  /** Index of the turn's first message within the input array. */
  startMsgIndex: number;
}

export function isCompactionReplacement(message: ChatMessage): boolean {
  if (message.info.role !== "user") return false;
  for (const part of message.parts) {
    if (part.type === "text" && part.text.startsWith(COMPACTION_MARKER)) return true;
  }
  return false;
}

export function splitTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as ChatMessage;
    const startsTurn = message.info.role === "user" || turns.length === 0;
    if (startsTurn) {
      turns.push({
        index: turns.length,
        messageIds: [message.info.id],
        messages: [message],
        startMsgIndex: i,
      });
    } else {
      const turn = turns[turns.length - 1] as Turn;
      turn.messageIds.push(message.info.id);
      turn.messages.push(message);
    }
  }
  return turns;
}

/** Stable JSON: recursively sorted object keys, no whitespace. */
export function canonicalJSON(value: unknown): string {
  return canonicalValue(value);
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalValue(v)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** Hash input for one message: role + concatenated text + tool projections.
 * Includes message.info.id to prevent cross-session collisions where
 * byte-identical messages in different sessions would otherwise share
 * the same contentHash (verified by adversarial review). */
export function messageHashInput(message: ChatMessage): {
  id: string;
  role: string;
  textParts: string;
  toolParts: Array<{ tool: string; output: string }>;
} {
  let textParts = "";
  const toolParts: Array<{ tool: string; output: string }> = [];
  for (const part of message.parts as Part[]) {
    if (part.type === "text") {
      textParts = textParts.length === 0 ? part.text : `${textParts}\n${part.text}`;
    } else {
      toolParts.push({ tool: part.tool, output: part.state.output ?? "" });
    }
  }
  return { id: message.info.id, role: message.info.role, textParts, toolParts };
}

/** Per-message content hash: sha256 of the canonical projection. */
export async function contentHash(message: ChatMessage): Promise<string> {
  return sha256Hex(canonicalJSON(messageHashInput(message)));
}

/**
 * Per-turn hash material: the ordered contentHash list of the turn's
 * messages. Returned as strings (hex) so callers can assemble historyHash.
 */
export async function turnHashes(turns: Turn[]): Promise<string[][]> {
  const out: string[][] = [];
  for (const turn of turns) {
    const hashes: string[] = [];
    for (const message of turn.messages) hashes.push(await contentHash(message));
    out.push(hashes);
  }
  return out;
}

/** Whole-history hash over the nested per-turn hash lists. */
export async function historyHash(turns: Turn[]): Promise<string> {
  return sha256Hex(canonicalJSON(await turnHashes(turns)));
}
