/**
 * FTS5 access for chunks: namespace-filtered BM25 search and the index/query
 * text preparation around it.
 *
 * Spike finding (M4, Bun sqlite 3.43.2): the default unicode61 tokenizer
 * keeps a contiguous run of CJK characters as ONE token, so a plain index
 * makes Chinese substring queries nearly useless ("压缩" would not match an
 * indexed run "历史压缩"). Fix, deterministic and dependency-free: both the
 * indexed columns and the query are pre-segmented by inserting spaces
 * between CJK characters — every CJK query becomes an ordered single-char
 * phrase match; ASCII words pass through untouched.
 */
import type { Database } from "bun:sqlite"

/** Scripts written without word separators: kana, CJK ideographs, compat. */
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]+/g

/** Insert spaces between CJK characters so unicode61 indexes them singly. */
export function segmentForIndex(text: string): string {
  return text.replace(CJK_RUN, (run) => [...run].join(" "))
}

/**
 * Cosmetic inverse of segmentForIndex for snippet display: collapse the
 * single spaces we injected between two CJK chars back (loop until stable,
 * since overlapping pairs need repeated passes).
 */
export function desegment(text: string): string {
  let out = text
  for (;;) {
    const next = out.replace(/([぀-ヿ㐀-䶿一-鿿豈-﫿]) ([぀-ヿ㐀-䶿一-鿿豈-﫿])/g, "$1$2")
    if (next === out) return out
    out = next
  }
}

/**
 * Build a safe FTS5 MATCH expression from raw user input:
 * - extract ASCII word runs and CJK runs as tokens (everything else is
 *   dropped, so operators like NEAR/AND/OR/"^ can never be injected),
 * - quote each token as a phrase (ASCII verbatim, CJK pre-segmented),
 * - join with spaces (implicit AND).
 *
 * The dropping is SILENT and by design: punctuation separators vanish
 * ("error: failed" searches error AND failed), scripts outside ASCII/CJK
 * (accents, Cyrillic, emoji) contribute nothing, and a query with no usable
 * token at all returns null → the caller answers an empty hit list. Callers
 * wanting richer matching must extend the extractor here, never splice user
 * text into the expression themselves.
 */
export function buildMatchQuery(query: string): string | null {
  const phrases: string[] = []
  const ascii = query.match(/[A-Za-z0-9_]+/g) ?? []
  // Question grammar is not evidence. Keep domain terms, paths and error
  // identifiers exact; never expand a question using expected answer text.
  const stopwords = new Set([
    "what",
    "which",
    "who",
    "whom",
    "when",
    "where",
    "why",
    "how",
    "was",
    "were",
    "is",
    "are",
    "the",
    "a",
    "an",
    "did",
    "does",
    "do",
    "we",
    "our",
    "you",
    "your",
    "it",
    "its",
    "for",
    "of",
    "to",
    "and",
    "please",
    "tell",
    "me",
  ])
  phrases.push(
    ...ascii
      .map((word) => word.toLowerCase())
      .filter((word) => !stopwords.has(word))
      .slice(0, 32)
      .map((word) => `"${word}"`)
  )
  for (const run of query.match(CJK_RUN) ?? []) {
    phrases.push(`"${[...run].join(" ")}"`)
  }
  return phrases.length > 0 ? phrases.join(" ") : null
}

export interface ChunkRow {
  content_hash: string
  project_id: string
  session_id: string
  role: string
  turn_index: number
  history_hash: string
  summary_text: string
  raw_excerpt: string
  keywords: string
  fullText?: string
}

export interface InsertChunkInput {
  fullText?: string
  contentHash: string
  projectId: string
  sessionId: string
  role: string
  turnIndex: number
  historyHash: string
  summaryText: string
  rawExcerpt: string
  keywords: string
}

/** Insert into `chunks` and `chunks_fts` in one transaction (stay in sync). */
export function insertChunk(db: Database, chunk: InsertChunkInput): void {
  initializeSegments(db)
  const write = db.transaction((input: InsertChunkInput) => {
    db.prepare("DELETE FROM segment_fts WHERE content_hash=?").run(input.contentHash)
    db.prepare("DELETE FROM segments WHERE content_hash=?").run(input.contentHash)
    const segments = splitContent(input.fullText ?? input.rawExcerpt)
    db.prepare(
      "INSERT INTO segment_inventory VALUES (?,?) ON CONFLICT(content_hash) DO UPDATE SET count=excluded.count"
    ).run(input.contentHash, segments.length)
    for (const segment of segments) {
      const id = `${input.contentHash}:${segment.startOffset}`
      db.prepare("INSERT INTO segments VALUES(?, ?, ?, ?, ?)").run(
        id,
        input.contentHash,
        segment.startOffset,
        segment.endOffset,
        segment.text
      )
      db.prepare("INSERT INTO segment_fts VALUES(?, ?, ?)").run(
        id,
        input.contentHash,
        segmentForIndex(segment.text)
      )
    }
    // Explicit delete+insert (NOT upsert): an fts5 table has no unique
    // constraint on content_hash, so OR REPLACE would silently duplicate.
    db.prepare(`DELETE FROM chunks WHERE content_hash = ?`).run(input.contentHash)
    db.prepare(`DELETE FROM chunks_fts WHERE content_hash = ?`).run(input.contentHash)
    db.prepare(
      `INSERT INTO chunks(
         content_hash, project_id, session_id, role, turn_index,
         history_hash, summary_text, raw_excerpt, keywords
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.contentHash,
      input.projectId,
      input.sessionId,
      input.role,
      input.turnIndex,
      input.historyHash,
      segmentForIndex(input.summaryText),
      segmentForIndex(input.rawExcerpt),
      segmentForIndex(input.keywords)
    )
    db.prepare(
      `INSERT INTO chunks_fts(content_hash, summary_text, raw_excerpt, keywords)
       VALUES (?, ?, ?, ?)`
    ).run(
      input.contentHash,
      segmentForIndex(input.summaryText),
      segmentForIndex(input.rawExcerpt),
      segmentForIndex(input.keywords)
    )
    db.prepare(
      `INSERT OR IGNORE INTO chunk_refs(
         project_id, session_id, history_hash, content_hash, role, turn_index
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.projectId,
      input.sessionId,
      input.historyHash,
      input.contentHash,
      input.role,
      input.turnIndex
    )
  })
  write(chunk)
}

export interface SearchHit {
  score: number
  hash: string
  projectId: string
  sessionId: string
  turnIndex: number
  /** Rows are only ever written from chat roles; narrowed at this boundary. */
  role: "user" | "assistant"
  snippet: string
  chunkId: string
  startOffset: number
  endOffset: number
}

/**
 * Namespace-filtered BM25 search. The project/session predicates live in the
 * SAME SQL statement as the MATCH (global constraint: no query-then-filter,
 * which could leak cross-session rows through the limit).
 *
 * `score` is the raw bm25() value (negative; more negative = better match).
 */
export function searchChunks(
  db: Database,
  namespace: { projectId: string; sessionId: string },
  matchExpression: string,
  limit: number
): SearchHit[] {
  initializeSegments(db)
  const rows = db
    .prepare(
      `WITH namespace_refs AS (
    SELECT content_hash, MIN(turn_index) AS turnIndex, MIN(role) AS role FROM chunk_refs
    WHERE project_id=? AND session_id=? GROUP BY content_hash)
    SELECT s.content_hash AS hash, s.id AS chunkId, s.start_offset AS startOffset,
    s.end_offset AS endOffset, s.text AS snippet, r.turnIndex, r.role, bm25(segment_fts) AS score
    FROM segment_fts JOIN segments s ON s.id=segment_fts.id
    JOIN namespace_refs r ON r.content_hash=s.content_hash WHERE segment_fts MATCH ?
    ORDER BY score, s.id LIMIT ?`
    )
    .all(namespace.projectId, namespace.sessionId, matchExpression, limit * 4) as Array<
    SearchHit & { chunkId: string; startOffset: number; endOffset: number }
  >
  const merged: typeof rows = []
  for (const row of rows) {
    const previous = merged.find(
      (x) => x.hash === row.hash && x.startOffset <= row.endOffset && row.startOffset <= x.endOffset
    )
    if (previous) {
      const start = Math.min(previous.startOffset, row.startOffset),
        end = Math.max(previous.endOffset, row.endOffset)
      const first = previous.startOffset <= row.startOffset ? previous : row,
        last = first === previous ? row : previous
      previous.snippet =
        first.snippet + last.snippet.slice(Math.max(0, first.endOffset - last.startOffset))
      previous.startOffset = start
      previous.endOffset = end
    } else merged.push({ ...row, ...namespace })
  }
  return merged.slice(0, limit)
}

export function initializeSegments(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS segment_inventory(content_hash TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS segment_hash ON segments(content_hash);
    CREATE VIRTUAL TABLE IF NOT EXISTS segment_fts USING fts5(id UNINDEXED, content_hash UNINDEXED, text);`)
}

/** ~512 estimated tokens, ~64 overlap; prefer natural sentence/line boundaries. Offsets are UTF-16. */
export function splitContent(
  text: string
): Array<{ text: string; startOffset: number; endOffset: number }> {
  const result = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + 2048)
    if (end < text.length) {
      const window = text.slice(start + 1024, end)
      const boundaries = [...window.matchAll(/\n|[.!?。！？](?:\s|$)/g)]
      const last = boundaries.at(-1)
      if (last) end = start + 1024 + last.index! + last[0].length
      if (/[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--
    }
    result.push({ text: text.slice(start, end), startOffset: start, endOffset: end })
    if (end === text.length) break
    start = Math.max(start + 1, end - 256)
    if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++
  }
  return result
}
