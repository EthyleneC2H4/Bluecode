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
import type { Database } from "bun:sqlite";

/** Scripts written without word separators: kana, CJK ideographs, compat. */
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]+/g;

/** Insert spaces between CJK characters so unicode61 indexes them singly. */
export function segmentForIndex(text: string): string {
  return text.replace(CJK_RUN, (run) => [...run].join(" "));
}

/**
 * Cosmetic inverse of segmentForIndex for snippet display: collapse the
 * single spaces we injected between two CJK chars back (loop until stable,
 * since overlapping pairs need repeated passes).
 */
export function desegment(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(
      /([぀-ヿ㐀-䶿一-鿿豈-﫿]) ([぀-ヿ㐀-䶿一-鿿豈-﫿])/g,
      "$1$2",
    );
    if (next === out) return out;
    out = next;
  }
}

/**
 * Build a safe FTS5 MATCH expression from raw user input:
 * - extract ASCII word runs and CJK runs as tokens (everything else is
 *   dropped, so operators like NEAR/AND/OR/"^ can never be injected),
 * - quote each token as a phrase (ASCII verbatim, CJK pre-segmented),
 * - join with spaces (implicit AND).
 * Returns null when the query contains no usable token.
 */
export function buildMatchQuery(query: string): string | null {
  const phrases: string[] = [];
  const ascii = query.match(/[A-Za-z0-9_]+/g) ?? [];
  phrases.push(...ascii.map((word) => `"${word.toLowerCase()}"`));
  for (const run of query.match(CJK_RUN) ?? []) {
    phrases.push(`"${[...run].join(" ")}"`);
  }
  return phrases.length > 0 ? phrases.join(" ") : null;
}

export interface ChunkRow {
  content_hash: string;
  project_id: string;
  session_id: string;
  role: string;
  turn_index: number;
  history_hash: string;
  summary_text: string;
  raw_excerpt: string;
  keywords: string;
}

export interface InsertChunkInput {
  contentHash: string;
  projectId: string;
  sessionId: string;
  role: string;
  turnIndex: number;
  historyHash: string;
  summaryText: string;
  rawExcerpt: string;
  keywords: string;
}

/** Insert into `chunks` and `chunks_fts` in one transaction (stay in sync). */
export function insertChunk(db: Database, chunk: InsertChunkInput): void {
  const write = db.transaction((input: InsertChunkInput) => {
    // Explicit delete+insert (NOT upsert): an fts5 table has no unique
    // constraint on content_hash, so OR REPLACE would silently duplicate.
    db.prepare(`DELETE FROM chunks WHERE content_hash = ?`).run(input.contentHash);
    db.prepare(`DELETE FROM chunks_fts WHERE content_hash = ?`).run(input.contentHash);
    db.prepare(
      `INSERT INTO chunks(
         content_hash, project_id, session_id, role, turn_index,
         history_hash, summary_text, raw_excerpt, keywords
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.contentHash,
      input.projectId,
      input.sessionId,
      input.role,
      input.turnIndex,
      input.historyHash,
      segmentForIndex(input.summaryText),
      segmentForIndex(input.rawExcerpt),
      segmentForIndex(input.keywords),
    );
    db.prepare(
      `INSERT INTO chunks_fts(content_hash, summary_text, raw_excerpt, keywords)
       VALUES (?, ?, ?, ?)`,
    ).run(
      input.contentHash,
      segmentForIndex(input.summaryText),
      segmentForIndex(input.rawExcerpt),
      segmentForIndex(input.keywords),
    );
  });
  write(chunk);
}

export interface SearchHit {
  score: number;
  hash: string;
  projectId: string;
  sessionId: string;
  turnIndex: number;
  /** Rows are only ever written from chat roles; narrowed at this boundary. */
  role: "user" | "assistant";
  snippet: string;
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
  limit: number,
): SearchHit[] {
  const rows = db
    .prepare(
      `SELECT c.content_hash AS hash, c.project_id AS projectId, c.session_id AS sessionId,
              c.turn_index AS turnIndex, c.role AS role,
              snippet(chunks_fts, 2, '[', ']', '…', 12) AS snip,
              bm25(chunks_fts) AS score
       FROM chunks_fts
       JOIN chunks c ON c.content_hash = chunks_fts.content_hash
       WHERE chunks_fts MATCH ?
         AND c.project_id = ? AND c.session_id = ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(matchExpression, namespace.projectId, namespace.sessionId, limit) as Array<{
    hash: string;
    projectId: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    snip: string;
    score: number;
  }>;
  return rows.map((row) => ({
    score: row.score,
    hash: row.hash,
    projectId: row.projectId,
    sessionId: row.sessionId,
    turnIndex: row.turnIndex,
    role: row.role as "user" | "assistant",
    snippet: desegment(row.snip),
  }));
}
