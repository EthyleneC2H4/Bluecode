import { buildMatchQuery, type SearchHit } from "./store/fts"

/** A card remains a contiguous, verbatim source range, never a generated answer. */
export function focusSearchHit(hit: SearchHit, query: string, maxChars = 512): SearchHit {
  if (hit.snippet.length <= maxChars) return hit
  const terms = (buildMatchQuery(query)?.match(/"([^"]+)"/g) ?? [])
    .map((term) => term.slice(1, -1).replaceAll(" ", "").toLowerCase())
  const lower = hit.snippet.toLowerCase()
  const positions = terms.flatMap((term) => {
    const out: number[] = []
    let position = lower.indexOf(term)
    while (position >= 0 && out.length < 32) {
      out.push(position)
      position = lower.indexOf(term, position + Math.max(1, term.length))
    }
    return out
  })
  let start = 0, best = -1
  for (const position of positions) {
    const candidate = Math.max(0, Math.min(hit.snippet.length - maxChars, position - Math.floor(maxChars / 3)))
    const window = lower.slice(candidate, candidate + maxChars)
    const score = terms.reduce((sum, term) => sum + (window.includes(term) ? Math.min(term.length, 32) : 0), 0)
    if (score > best) { best = score; start = candidate }
  }
  if (/[\uDC00-\uDFFF]/.test(hit.snippet[start] ?? "")) start++
  let end = Math.min(hit.snippet.length, start + maxChars)
  if (/[\uDC00-\uDFFF]/.test(hit.snippet[end] ?? "")) end--
  return { ...hit, snippet: hit.snippet.slice(start, end), startOffset: hit.startOffset + start, endOffset: hit.startOffset + end }
}
