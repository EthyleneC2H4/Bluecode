import { encodeCursor, decodeCursor, paginateText } from "@bluecode/shared"

export interface HistoryRow { hash: string; role: "user" | "assistant"; turnIndex: number }
export interface HistoryReader {
  row(hash: string, offset: number): Promise<HistoryRow | null>
  content(row: HistoryRow): Promise<{ text: string } | { child: string } | null>
}
export interface HistoryFrontier {
  stack: Array<{ hash: string; offset: number }>
  ordinal: number
  intra: number
}

/** The frontier, not a flattened ordinal, is persisted between pages. */
export async function readHistoryPage(
  reader: HistoryReader,
  original: HistoryFrontier,
  options: { maxBytes?: number | undefined; maxTokens?: number | undefined; limit?: number | undefined },
) {
  const state = structuredClone(original)
  const items: Array<{ contentHash: string; role: "user" | "assistant"; turnIndex: number; content: string }> = []
  const missingHashes: string[] = []
  let remaining = Math.min(options.maxBytes ?? 32768, 131072, options.maxTokens ?? 2048, 8192)
  let count = 0
  const limit = Math.min(options.limit ?? 10, 50)
  while (state.stack.length) {
    const frame = state.stack.at(-1)!
    const row = await reader.row(frame.hash, frame.offset)
    if (!row) {
      state.stack.pop()
      continue
    }
    const value = await reader.content(row)
    if (value && "child" in value) {
      if (state.stack.length >= 128 || state.stack.some((item) => item.hash === value.child))
        throw new Error("Invalid archive lineage")
      frame.offset++
      state.stack.push({ hash: value.child, offset: 0 })
      continue
    }
    // Peek at most one leaf to distinguish a complete page from a continuation.
    if (remaining <= 0 || count >= limit) break
    if (!value) {
      missingHashes.push(row.hash)
      frame.offset++
      state.ordinal++
      state.intra = 0
      count++
      continue
    }
    let page
    try {
      page = paginateText(value.text, {
        ref: row.hash,
        cursor: encodeCursor(row.hash, state.intra),
        maxBytes: remaining,
        maxTokens: remaining,
      })
    } catch (error) {
      if (items.length) break
      throw error
    }
    items.push({ contentHash: row.hash, role: row.role, turnIndex: row.turnIndex, content: page.content })
    remaining -= page.bytes
    count++
    if (page.nextCursor) {
      state.intra = decodeCursor(page.nextCursor, row.hash)
      break
    }
    frame.offset++
    state.ordinal++
    state.intra = 0
  }
  return { items, missingHashes, more: state.stack.length > 0, state }
}
