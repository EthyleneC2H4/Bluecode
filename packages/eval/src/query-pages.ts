/** Fixed top-five query policy. Pages carry pieces of ranked hits, not new ranks. */
export interface QueryHit {
  hash: string
  chunkId?: string
  snippet: string
  startOffset?: number
  endOffset?: number
}
interface QueryPage {
  hits?: QueryHit[]
  nextCursor?: string | null
}

export async function collectQueryHits(
  fetch: (cursor: string | undefined) => Promise<QueryPage>
): Promise<QueryHit[]> {
  const hits: QueryHit[] = [],
    byIdentity = new Map<string, QueryHit>(),
    cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const result = await fetch(cursor)
    if (!Array.isArray(result.hits)) return []
    for (const piece of result.hits) {
      const key = JSON.stringify([piece.hash, piece.chunkId ?? null])
      const previous = byIdentity.get(key)
      if (previous) {
        if (
          previous.endOffset === undefined ||
          piece.startOffset !== previous.endOffset ||
          piece.endOffset !== piece.startOffset + piece.snippet.length
        )
          throw new Error("non-contiguous query hit continuation")
        previous.snippet += piece.snippet
        previous.endOffset = piece.endOffset
      } else {
        // The API selects at most five ranked hits before paging. Defensively ignore later ranks.
        if (hits.length === 5) continue
        const hit = { ...piece }
        byIdentity.set(key, hit)
        hits.push(hit)
      }
    }
    // Reaching five ranks does not complete the fifth hit. Consume its cursor tail too.
    if (!result.nextCursor) return hits
    if (cursors.has(result.nextCursor)) throw new Error("repeated query cursor")
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw new Error("query pagination exceeded page limit")
}
