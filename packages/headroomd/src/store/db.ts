/**
 * SQLite (bun:sqlite) persistence, split by survivability:
 *
 * - meta.db — the ATTRIBUTION LEDGER (cas_meta). Durable; it must outlive
 *   index.db because it is what makes index reconstruction possible after
 *   the index file is lost or corrupted.
 * - index.db — everything DERIVED (chunks, chunks_fts, histories).
 *   Deletable at any time: startup detects loss/corruption and rebuilds
 *   from meta.db + objects (objects remain the source of truth for
 *   content; cas_meta for attribution).
 *
 * Both run WAL + NORMAL synchronous.
 */
import { Database } from "bun:sqlite";
import type { ChatMessage } from "@bluecode/contracts";
import { estimateTokens } from "@bluecode/shared";
import { readMessageObject } from "./objects";
import { insertChunk } from "./fts";
import {
  messageExcerpt,
  messageSummary,
  messageTokens,
  keywords as keywordize,
  historySummary,
} from "../summarize";
import { type Turn, splitTurns } from "../turns";

export const SCHEMA_VERSION = 1;

export interface HeadroomDb {
  readonly db: Database;
  readonly path: string;
  close(): void;
}

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS cas_meta(
  hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  msg_seq INTEGER NOT NULL,
  history_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cas_meta_session ON cas_meta(project_id, session_id);
`;

const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS histories(
  history_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw_tokens INTEGER NOT NULL,
  summary_tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks(
  content_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  history_hash TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  raw_excerpt TEXT NOT NULL,
  keywords TEXT NOT NULL
);
-- One-row heal bookkeeping: the chunk count the last full rebuild produced.
-- Without it, indexLooksLost's "chunks < cas_meta" probe stays true forever
-- once any object goes missing (objects are truth, so a rebuild legitimately
-- writes fewer chunks than cas_meta rows), and the daemon rebuilt on EVERY
-- boot. Existing index.dbs gain the empty table automatically via IF NOT
-- EXISTS; an absent row means "no recorded expectation" and falls back to the
-- legacy comparison. See indexLooksLost.
CREATE TABLE IF NOT EXISTS rebuild_state(expected_chunks INTEGER NOT NULL);
`;

function openDbWith(path: string, schema: string): HeadroomDb {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(schema);
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (version === 0) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return { db, path, close: () => db.close() };
}

export function openMetaDb(path: string): HeadroomDb {
  return openDbWith(path, META_SCHEMA);
}

export function openIndexDb(path: string): HeadroomDb {
  const handle = openDbWith(path, INDEX_SCHEMA);
  handle.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content_hash UNINDEXED, summary_text, raw_excerpt, keywords
  )`);
  return handle;
}

/** The pair of databases one daemon instance works against. */
export interface HeadroomStore {
  readonly meta: HeadroomDb;
  readonly index: HeadroomDb;
  close(): void;
}

export function openStore(dataDir: string): HeadroomStore {
  const meta = openMetaDb(`${dataDir}/meta.db`);
  const index = openIndexDb(`${dataDir}/index.db`);
  return {
    meta,
    index,
    close: () => {
      index.close();
      meta.close();
    },
  };
}

/** True when the on-disk schema is not the one this build speaks. */
export function schemaMismatch(handle: HeadroomDb): boolean {
  const version = (handle.db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  return version !== SCHEMA_VERSION;
}

/** Structural probe of the fts index; false signals a needed rebuild. */
export function ftsHealthy(handle: HeadroomDb): boolean {
  try {
    handle.db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')").run();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// cas_meta lives in meta.db
// ---------------------------------------------------------------------------

export interface CasMetaInput {
  hash: string;
  projectId: string;
  sessionId: string;
  role: string;
  turnIndex: number;
  msgSeq: number;
  historyHash: string;
  createdAt: number;
}

export function insertCasMeta(handle: HeadroomDb, meta: CasMetaInput): void {
  handle.db
    .prepare(
      `INSERT OR IGNORE INTO cas_meta(hash, project_id, session_id, role, turn_index, msg_seq, history_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meta.hash,
      meta.projectId,
      meta.sessionId,
      meta.role,
      meta.turnIndex,
      meta.msgSeq,
      meta.historyHash,
      meta.createdAt,
    );
}

export function countCasMeta(handle: HeadroomDb): number {
  return (handle.db.prepare(`SELECT COUNT(*) AS n FROM cas_meta`).get() as { n: number }).n;
}

/** Distinct (project, session) namespaces archived so far — health metric. */
export function countSessions(handle: HeadroomDb): number {
  return (
    handle.db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT project_id, session_id FROM cas_meta)`)
      .get() as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// derived rows live in index.db
// ---------------------------------------------------------------------------

export interface HistoryRow {
  historyHash: string;
  projectId: string;
  sessionId: string;
  summary: string;
  rawTokens: number;
  summaryTokens: number;
}

export function upsertHistory(handle: HeadroomDb, row: HistoryRow, createdAt: number): void {
  // INSERT OR IGNORE keeps the FIRST write's created_at (and summary) —
  // identical history hashes are byte-identical by construction anyway.
  handle.db
    .prepare(
      `INSERT OR IGNORE INTO histories(history_hash, project_id, session_id, summary, raw_tokens, summary_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.historyHash,
      row.projectId,
      row.sessionId,
      row.summary,
      row.rawTokens,
      row.summaryTokens,
      createdAt,
    );
}

export function getHistory(handle: HeadroomDb, historyHash: string): HistoryRow | null {
  return (handle.db
    .prepare(
      `SELECT history_hash AS historyHash, project_id AS projectId, session_id AS sessionId,
              summary, raw_tokens AS rawTokens, summary_tokens AS summaryTokens
       FROM histories WHERE history_hash = ?`,
    )
    .get(historyHash) ?? null) as HistoryRow | null;
}

/** Whether an index row exists for this content hash (idempotency probe). */
export function hasChunk(handle: HeadroomDb, contentHash: string): boolean {
  return (
    handle.db.prepare(`SELECT 1 FROM chunks WHERE content_hash = ?`).get(contentHash) !== null
  );
}

export function countChunks(handle: HeadroomDb): number {
  return (handle.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
}

/**
 * Whether index.db needs the startup rebuild, per the heal-thrash fix:
 *
 * - No rebuild_state row (fresh or deleted index.db — nothing recorded yet):
 *   fall back to the legacy attribution-vs-chunks comparison.
 * - Row present: fire only when chunks fell BELOW the last rebuild's
 *   expectation (rows genuinely lost). Strictly less-than, so normal growth
 *   never false-triggers and a missing OBJECT (a legitimate rebuild skip,
 *   leaving chunks < cas_meta permanently) converges after one repair instead
 *   of re-rebuilding every boot.
 */
export function indexLooksLost(indexHandle: HeadroomDb, metaHandle: HeadroomDb): boolean {
  const recorded = indexHandle.db
    .prepare(`SELECT expected_chunks AS n FROM rebuild_state`)
    .get() as { n: number } | null;
  if (recorded === null) {
    return countCasMeta(metaHandle) > 0 && countChunks(indexHandle) < countCasMeta(metaHandle);
  }
  return countChunks(indexHandle) < recorded.n;
}

// ---------------------------------------------------------------------------
// Rebuild: objects + cas_meta are facts; everything in index.db is derivable.
// ---------------------------------------------------------------------------

interface CasMetaRow {
  hash: string;
  project_id: string;
  session_id: string;
  role: string;
  turn_index: number;
  msg_seq: number;
  history_hash: string;
  created_at: number;
}

/**
 * Drop every derived row and reconstruct chunks/chunks_fts/histories in
 * `indexHandle` from objects + `metaHandle.cas_meta`. Summaries are
 * recomputed with the deterministic summarizer, so a rebuilt index matches
 * the original one.
 *
 * Two phases: async object prefetch OUTSIDE the transaction (bun:sqlite
 * transaction callbacks are synchronous), then one sync write transaction.
 * cas_meta rows whose object vanished are skipped — the object store is
 * truth. A PRESENT but corrupt object (truncated gzip / bad JSON) is also
 * skipped, counted and warned: readMessageObject throws on those, and the
 * old bare await let one bad block escape the startup self-heal and crash-
 * loop the daemon (devlog #37's scenario; #37's JSON.stringify re-validation
 * was dead code — the throw happens inside the read, before any stringify).
 * Objects and cas_meta rows are never deleted either way.
 */
export async function rebuildFromObjects(
  dataDir: string,
  metaHandle: HeadroomDb,
  indexHandle: HeadroomDb,
): Promise<{ chunks: number; histories: number; skipped: number }> {
  const metas = metaHandle.db
    .prepare(
      `SELECT hash, project_id, session_id, role, turn_index, msg_seq, history_hash, created_at
       FROM cas_meta ORDER BY project_id, session_id, msg_seq`,
    )
    .all() as CasMetaRow[];

  const resolved: Array<{ meta: CasMetaRow; message: ChatMessage }> = [];
  let skipped = 0;
  for (const meta of metas) {
    try {
      const projection = await readMessageObject(dataDir, meta.hash);
      if (projection === null) continue; // vanished object: cas_meta outlives it
      resolved.push({ meta, message: { info: projection.info, parts: projection.parts } });
    } catch (err) {
      // Corrupt stored object: degrade to "one item lost" instead of aborting
      // the whole heal. Named hash + error keeps divergence diagnosable.
      skipped += 1;
      console.warn(
        `[headroomd] rebuild: skipping corrupt object ${meta.hash}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const chunkWrites: Parameters<typeof insertChunk>[1][] = [];
  const groups = new Map<
    string,
    {
      projectId: string;
      sessionId: string;
      historyHash: string;
      messages: ChatMessage[];
      createdAt: number;
    }
  >();

  for (const { meta, message } of resolved) {
    const summaryText = messageSummary(message);
    const rawExcerpt = messageExcerpt(message);
    chunkWrites.push({
      contentHash: meta.hash,
      projectId: meta.project_id,
      sessionId: meta.session_id,
      role: meta.role,
      turnIndex: meta.turn_index,
      historyHash: meta.history_hash,
      summaryText,
      rawExcerpt,
      keywords: keywordize(`${summaryText} ${rawExcerpt}`),
    });

    const key = `${meta.project_id} ${meta.session_id} ${meta.history_hash}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        projectId: meta.project_id,
        sessionId: meta.session_id,
        historyHash: meta.history_hash,
        messages: [],
        createdAt: meta.created_at,
      };
      groups.set(key, group);
    }
    group.messages.push(message);
  }

  const historyWrites: Array<{ row: HistoryRow; createdAt: number }> = [];
  for (const group of groups.values()) {
    const turns: Turn[] = splitTurns(group.messages).map((turn, index) => ({ ...turn, index }));
    const summary = historySummary(turns);
    historyWrites.push({
      row: {
        historyHash: group.historyHash,
        projectId: group.projectId,
        sessionId: group.sessionId,
        summary,
        rawTokens: group.messages.reduce((sum, m) => sum + messageTokens(m), 0),
        summaryTokens: estimateTokens(summary),
      },
      createdAt: group.createdAt,
    });
  }

  const apply = indexHandle.db.transaction(() => {
    indexHandle.db.exec("DELETE FROM chunks");
    indexHandle.db.exec("DELETE FROM chunks_fts");
    indexHandle.db.exec("DELETE FROM histories");
    for (const chunk of chunkWrites) insertChunk(indexHandle.db, chunk);
    for (const write of historyWrites) {
      // createdAt rides in from cas_meta (rows ordered by msg_seq, so each
      // group's first row is its earliest) — a rebuilt summary keeps the
      // archive's original timestamp instead of resetting to 0. Deterministic
      // because cas_meta itself is the stable input.
      upsertHistory(indexHandle, write.row, write.createdAt);
    }
    // Record the heal expectation INSIDE the same transaction as the rows it
    // describes, so indexLooksLost can never observe one without the other
    // (delete-then-insert: single-row table needs no unique constraint).
    indexHandle.db.exec("DELETE FROM rebuild_state");
    indexHandle.db
      .prepare(`INSERT INTO rebuild_state(expected_chunks) VALUES (?)`)
      .run(chunkWrites.length);
  });
  apply();

  return { chunks: chunkWrites.length, histories: historyWrites.length, skipped };
}
