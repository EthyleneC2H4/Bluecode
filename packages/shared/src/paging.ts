/** Cursor-bound, Unicode-safe retrieval pages. Limits apply to content, not the RPC envelope. */

export const DEFAULT_PAGE_TOKENS = 2048
export const DEFAULT_PAGE_BYTES = 32 * 1024
export const MAX_PAGE_TOKENS = 8192
export const MAX_PAGE_BYTES = 128 * 1024

export interface PageOptions {
  ref: string
  cursor?: string | undefined
  maxBytes?: number | undefined
  maxTokens?: number | undefined
}
export interface TextPage {
  content: string
  nextCursor: string | null
  truncated: boolean
  tokens: number
  bytes: number
  tokenCountKind: "utf8-upper-bound"
}

function limit(value: number | undefined, fallback: number, cap: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Page budget must be a positive integer")
  return Math.min(value, cap)
}

export function encodeCursor(ref: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, ref, offset })).toString("base64url")
}

export function decodeCursor(cursor: string | undefined, ref: string): number {
  if (cursor === undefined) return 0
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new Error("Invalid retrieval cursor")
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid retrieval cursor")
  }
  const item = value as { v?: unknown; ref?: unknown; offset?: unknown } | null
  if (
    !item ||
    item.v !== 1 ||
    item.ref !== ref ||
    !Number.isSafeInteger(item.offset) ||
    (item.offset as number) < 0
  ) {
    throw new Error("Retrieval cursor does not match reference")
  }
  return item.offset as number
}

function boundary(text: string, index: number): number {
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index
}

export function paginateText(text: string, options: PageOptions): TextPage {
  const maxBytes = limit(options.maxBytes, DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES)
  const maxTokens = limit(options.maxTokens, DEFAULT_PAGE_TOKENS, MAX_PAGE_TOKENS)
  const start = decodeCursor(options.cursor, options.ref)
  if (start > text.length || boundary(text, start) !== start)
    throw new Error("Cursor outside content boundary")
  let end = start
  let bytes = 0
  while (end < text.length) {
    const cp = text.codePointAt(end)!
    const width = cp > 0xffff ? 2 : 1
    const size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4
    if (bytes + size > Math.min(maxBytes, maxTokens)) break
    bytes += size
    end += width
  }
  const content = text.slice(start, end)
  // A byte upper bound avoids loading BPE tables or quadratic repeated-token work
  // on the retrieval path. The eval harness separately counts exact model tokens.
  const tokens = bytes
  if (end === start && start < text.length)
    throw new Error("Page budget cannot fit the next code point")
  return {
    content,
    nextCursor: end < text.length ? encodeCursor(options.ref, end) : null,
    truncated: end < text.length,
    tokens,
    bytes: Buffer.byteLength(content, "utf8"),
    tokenCountKind: "utf8-upper-bound",
  }
}
