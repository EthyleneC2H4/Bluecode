/**
 * Deterministic extractive summarization — no LLM, no clocks, no randomness.
 * Same input always yields byte-identical output (the eval harness and the
 * store rebuild both rely on this).
 *
 * Turn summary = user intent + assistant action points + tool anchors.
 * History summary = "[T<index>] <turn summary>" lines; beyond 12 turns only
 * the first 2 and last 8 are kept with an elision counter between them.
 */
import type { ChatMessage } from "@bluecode/contracts";
import { estimateTokens } from "@bluecode/shared";
import { type Turn, isCompactionReplacement } from "./turns";

const SENTENCE_CAP = 120;
const ANCHOR_CAP = 100;
const MAX_ACTION_POINTS = 3;
const MAX_TOOL_ANCHORS = 5;
const HISTORY_FULL_TURNS = 12;
const HISTORY_HEAD = 2;
const HISTORY_TAIL = 8;
const EXCERPT_CAP = 200;

/** First sentence of a text block: split on CJK/ASCII terminators or newline. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const match = trimmed.match(/^.*?[。！？!?；;.\n]|^.*$/s);
  const sentence = (match?.[0] ?? trimmed).trim();
  return cap(sentence, SENTENCE_CAP);
}

function cap(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Plain text of a message: text parts joined; used for hashing/excerpts. */
export function messageText(message: ChatMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") chunks.push(part.text);
  }
  return chunks.join("\n");
}

function firstToolOutputLine(message: ChatMessage): Array<{ tool: string; line: string }> {
  const out: Array<{ tool: string; line: string }> = [];
  for (const part of message.parts) {
    if (part.type !== "tool") continue;
    const output = part.state.output ?? "";
    const line = output.split("\n").find((l) => l.trim().length > 0) ?? "";
    out.push({ tool: part.tool, line });
  }
  return out;
}

/** Three-segment extractive summary of one turn. */
export function turnSummary(turn: Turn): string {
  const segments: string[] = [];

  // 1. user intent — the turn's opening user message.
  for (const message of turn.messages) {
    if (message.info.role !== "user") continue;
    const text = messageText(message);
    if (text.length > 0) {
      segments.push(`intent: ${firstSentence(text)}`);
      break;
    }
  }

  // 2. assistant action points — first sentence per assistant text part.
  let actions = 0;
  for (const message of turn.messages) {
    if (message.info.role !== "assistant" || actions >= MAX_ACTION_POINTS) continue;
    const text = messageText(message);
    if (text.trim().length === 0) continue;
    segments.push(`action: ${firstSentence(text)}`);
    actions += 1;
  }

  // 3. tool anchors — tool name plus its first non-empty output line.
  let anchors = 0;
  for (const message of turn.messages) {
    if (anchors >= MAX_TOOL_ANCHORS) break;
    for (const { tool, line } of firstToolOutputLine(message)) {
      if (anchors >= MAX_TOOL_ANCHORS) break;
      segments.push(`tool ${tool}: ${cap(line, ANCHOR_CAP)}`);
      anchors += 1;
    }
  }

  return segments.join(" | ");
}

/** Deterministic whole-history summary across turns. */
export function historySummary(turns: Turn[]): string {
  if (turns.length === 0) return "";
  const lines = turns.map((turn) => `[T${turn.index}] ${turnSummary(turn)}`);
  if (lines.length <= HISTORY_FULL_TURNS) return lines.join("\n");
  const elided = turns.length - HISTORY_HEAD - HISTORY_TAIL;
  return [
    ...lines.slice(0, HISTORY_HEAD),
    `[… ${elided} turns …]`,
    ...lines.slice(lines.length - HISTORY_TAIL),
  ].join("\n");
}

/**
 * Compact single-message summary (chunk summary_text column): role-tagged
 * first sentence, replacement messages labeled so rebuilt indexes stay
 * faithful to what a query can hit.
 */
export function messageSummary(message: ChatMessage): string {
  const tag =
    message.info.role === "user"
      ? isCompactionReplacement(message)
        ? "compacted-history"
        : "user"
      : "assistant";
  const text = messageText(message).trim();
  if (text.length === 0) {
    const tools = firstToolOutputLine(message);
    if (tools.length === 0) return `${tag}: (empty)`;
    return `${tag}: ${tools
      .slice(0, 2)
      .map(({ tool, line }) => `tool ${tool}: ${cap(line, ANCHOR_CAP)}`)
      .join(" | ")}`;
  }
  return `${tag}: ${firstSentence(text)}`;
}

/** First EXCERPT_CAP chars of the plain text (FTS body / snippet source). */
export function messageExcerpt(message: ChatMessage): string {
  const text = messageText(message);
  if (text.length > 0) return text.slice(0, EXCERPT_CAP);
  const tools = firstToolOutputLine(message);
  return tools
    .map(({ tool, line }) => `${tool}: ${line}`)
    .join("\n")
    .slice(0, EXCERPT_CAP);
}

/** Estimated token cost of a message: text parts + tool outputs, flattened. */
export function messageTokens(message: ChatMessage): number {
  const flat = message.parts
    .map((part) => (part.type === "text" ? part.text : (part.state.output ?? "")))
    .join("\n");
  return estimateTokens(flat);
}

// ---------------------------------------------------------------------------
// keywords — deterministic top-8 term frequency with a small stopword list
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "was", "were",
  "for", "on", "with", "at", "by", "it", "this", "that", "be", "as", "from",
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一个",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看",
]);

/**
 * Tokenize into ASCII word runs and single CJK characters (mirrors how the
 * FTS index pre-segments CJK), drop stopwords/pure digits, count frequency.
 * Ties broken by first occurrence order — fully deterministic.
 */
export function keywords(text: string, limit = 8): string {
  const tokens: string[] = [];
  const asciiRuns = text.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
  for (const run of asciiRuns) tokens.push(run.toLowerCase());
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x3040 && code <= 0x30ff) tokens.push(ch); // kana
    else if (code >= 0x3400 && code <= 0x9fff) tokens.push(ch); // CJK ideographs
    else if (code >= 0xf900 && code <= 0xfaff) tokens.push(ch); // compat ideographs
  }
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (token.length === 0 || STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term)
    .join(" ");
}
