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
import { existsSync, rmSync } from "node:fs";
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
CREATE TABLE IF NOT EXISTS archive_refs(
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  msg_seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  role TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id, history_hash, msg_seq)
);
CREATE INDEX IF NOT EXISTS archive_refs_hash
  ON archive_refs(project_id, session_id, hash);
`;

/** Single source of truth for the heal-bookkeeping table (schema + migration). */
const REBUILD_STATE_DDL = `CREATE TABLE IF NOT EXISTS rebuild_state(
  expected_chunks INTEGER NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0
)`;

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
CREATE TABLE IF NOT EXISTS chunk_refs(
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  history_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id, history_hash, content_hash)
);
CREATE INDEX IF NOT EXISTS chunk_refs_session
  ON chunk_refs(project_id, session_id, content_hash);
-- One-row heal bookkeeping from the last full rebuild:
--   expected_chunks — chunk rows the rebuild wrote;
--   skipped         — cas_meta rows it could NOT index (object missing or
--                     corrupt), i.e. the permanent gap between cas_meta and
--                     chunks. Without recording it, any chunks-vs-cas_meta
--                     probe stays true forever once an object goes missing
--                     (objects are truth, so that gap is legitimate), and the
--                     daemon rebuilt on EVERY boot. An absent row means "no
--                     recorded expectation" and falls back to the legacy
--                     comparison. See indexLooksLost and migrateRebuildState.
${REBUILD_STATE_DDL}
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
  const handle = openDbWith(path, META_SCHEMA);
  // Additive compatibility backfill: old v1 databases only have cas_meta.
  // Keep that object ledger intact and derive one archive occurrence for
  // every legacy row; no destructive table migration is required.
  handle.db.exec(`
    INSERT OR IGNORE INTO archive_refs(
      project_id, session_id, history_hash, msg_seq,
      hash, role, turn_index, created_at
    )
    SELECT project_id, session_id, history_hash, msg_seq,
           hash, role, turn_index, created_at
    FROM cas_meta
  `);
  return handle;
}

export function openIndexDb(path: string): HeadroomDb {
  // index.db is entirely derived. If only its main file was removed, SQLite
  // must not replay stale WAL/SHM pages against the newly created database.
  if (!existsSync(path)) {
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
  const handle = openDbWith(path, INDEX_SCHEMA);
  handle.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content_hash UNINDEXED, summary_text, raw_excerpt, keywords
  )`);
  handle.db.exec(`
    INSERT OR IGNORE INTO chunk_refs(
      project_id, session_id, history_hash, content_hash, role, turn_index
    )
    SELECT project_id, session_id, history_hash, content_hash, role, turn_index
    FROM chunks
  `);
  migrateRebuildState(handle.db);
  return handle;
}

/**
 * One-time migration for index.dbs written before the `skipped` column:
 * CREATE TABLE IF NOT EXISTS cannot widen the old single-column table, so it
 * must be dropped and recreated. Losing the bookkeeping row is cheap — an
 * absent row only falls back to the legacy comparison (see indexLooksLost),
 * and the next heal re-records fresh state and converges.
 */
function migrateRebuildState(db: Database): void {
  const columns = db.prepare(`PRAGMA table_info(rebuild_state)`).all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((column) => column.name === "skipped")) {
    db.exec(`DROP TABLE rebuild_state`);
    db.exec(REBUILD_STATE_DDL);
  }
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
  handle.db
    .prepare(
      `INSERT OR IGNORE INTO archive_refs(
         project_id, session_id, history_hash, msg_seq,
         hash, role, turn_index, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meta.projectId,
      meta.sessionId,
      meta.historyHash,
      meta.msgSeq,
      meta.hash,
      meta.role,
      meta.turnIndex,
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
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT project_id, session_id FROM archive_refs)`)
      .get() as { n: number }
  ).n;
}

function countArchiveRefs(handle: HeadroomDb): number {
  // chunk_refs deliberately deduplicates repeated occurrences of the same
  // content inside one history; compare the equivalent logical cardinality.
  return (
    handle.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM archive_refs
           GROUP BY project_id, session_id, history_hash, hash
         )`,
      )
      .get() as { n: number }
  ).n;
}

function countChunkRefs(handle: HeadroomDb): number {
  return (handle.db.prepare(`SELECT COUNT(*) AS n FROM chunk_refs`).get() as { n: number }).n;
}

export interface CasMetaPageRow {
  hash: string;
  role: "user" | "assistant";
  turnIndex: number;
  msgSeq: number;
}

/** Namespace ownership check for direct content-hash retrieval. */
export function ownsCasMeta(
  handle: HeadroomDb,
  namespace: { projectId: string; sessionId: string },
  hash: string,
): boolean {
  return (
    handle.db
      .prepare(
        `SELECT 1 FROM archive_refs
         WHERE project_id = ? AND session_id = ? AND hash = ?`,
      )
      .get(namespace.projectId, namespace.sessionId, hash) !== null
  );
}

export function hasHistoryMeta(
  handle: HeadroomDb,
  namespace: { projectId: string; sessionId: string },
  historyHash: string,
): boolean {
  return (
    handle.db
      .prepare(
        `SELECT 1 FROM archive_refs
         WHERE project_id = ? AND session_id = ? AND history_hash = ? LIMIT 1`,
      )
      .get(namespace.projectId, namespace.sessionId, historyHash) !== null
  );
}

/** Read attribution rows in original message order; caller requests limit + 1. */
export function listHistoryMeta(
  handle: HeadroomDb,
  namespace: { projectId: string; sessionId: string },
  historyHash: string,
  offset: number,
  limit: number,
): CasMetaPageRow[] {
  return handle.db
    .prepare(
      `SELECT hash, role, turn_index AS turnIndex, msg_seq AS msgSeq
       FROM archive_refs
       WHERE project_id = ? AND session_id = ? AND history_hash = ?
       ORDER BY msg_seq ASC
       LIMIT ? OFFSET ?`,
    )
    .all(namespace.projectId, namespace.sessionId, historyHash, limit, offset) as CasMetaPageRow[];
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

export function hasChunkRef(
  handle: HeadroomDb,
  namespace: { projectId: string; sessionId: string },
  historyHash: string,
  contentHash: string,
): boolean {
  return (
    handle.db
      .prepare(
        `SELECT 1 FROM chunk_refs
         WHERE project_id = ? AND session_id = ?
           AND history_hash = ? AND content_hash = ?`,
      )
      .get(
        namespace.projectId,
        namespace.sessionId,
        historyHash,
        contentHash,
      ) !== null
  );
}

export function countChunks(handle: HeadroomDb): number {
  return (handle.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
}

/**
 * Whether index.db needs the startup rebuild:
 *
 * - No rebuild_state row (fresh or deleted index.db — nothing recorded yet):
 *   fall back to the legacy attribution-vs-chunks comparison.
 * - Row present, two failure shapes (both strictly-less-than so normal growth
 *   never false-triggers and a converged state stays converged):
 *   1. chunks BELOW expectation — committed chunk rows were genuinely lost.
 *   2. chunks + skipped BELOW cas_meta — the steady-state invariant
 *      `chunks == cas_meta - skipped` broke with both sides above the
 *      recorded counts. That is meta.db ahead of index.db: WAL + NORMAL
 *      synchronous can roll the two files back to DIFFERENT checkpoints on
 *      power loss (or crash between the meta and index write transactions),
 *      stranding cas_meta rows whose chunk writes never landed even though
 *      neither file dropped below its baseline. Without disjunct 2 the old
 *      `chunks < expected_chunks` probe stayed false forever in that window.
 */
export function indexLooksLost(indexHandle: HeadroomDb, metaHandle: HeadroomDb): boolean {
  const recorded = indexHandle.db
    .prepare(`SELECT expected_chunks AS expectedChunks, skipped FROM rebuild_state`)
    .get() as { expectedChunks: number; skipped: number } | null;
  if (recorded === null) {
    return (
      (countCasMeta(metaHandle) > 0 && countChunks(indexHandle) < countCasMeta(metaHandle)) ||
      countChunkRefs(indexHandle) < countArchiveRefs(metaHandle)
    );
  }
  const chunks = countChunks(indexHandle);
  return (
    chunks < recorded.expectedChunks ||
    countChunkRefs(indexHandle) + recorded.skipped < countArchiveRefs(metaHandle)
  );
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
       FROM archive_refs ORDER BY project_id, session_id, history_hash, msg_seq`,
    )
    .all() as CasMetaRow[];

  const resolved: Array<{ meta: CasMetaRow; message: ChatMessage }> = [];
  const skippedRefs = new Set<string>();
  for (const meta of metas) {
    const refKey = JSON.stringify([
      meta.project_id,
      meta.session_id,
      meta.history_hash,
      meta.hash,
    ]);
    try {
      const projection = await readMessageObject(dataDir, meta.hash);
      if (projection === null) {
        // Vanished object: archive_refs outlives it. Deliberately not warned
        // (unlike the corrupt branch), but COUNTED once per logical chunk ref.
        skippedRefs.add(refKey);
        continue;
      }
      resolved.push({ meta, message: { info: projection.info, parts: projection.parts } });
    } catch (err) {
      // Corrupt stored object: degrade to "one item lost" instead of aborting
      // the whole heal. Named hash + error keeps divergence diagnosable.
      skippedRefs.add(refKey);
      console.warn(
        `[headroomd] rebuild: skipping corrupt object ${meta.hash}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const skipped = skippedRefs.size;

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

  const expectedChunks = new Set(chunkWrites.map((chunk) => chunk.contentHash)).size;
  const apply = indexHandle.db.transaction(() => {
    indexHandle.db.exec("DELETE FROM chunks");
    indexHandle.db.exec("DELETE FROM chunks_fts");
    indexHandle.db.exec("DELETE FROM chunk_refs");
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
    // skipped rides along: it is the legitimate cas_meta-vs-chunks gap this
    // rebuild converged to, and indexLooksLost subtracts it from cas_meta.
    indexHandle.db.exec("DELETE FROM rebuild_state");
    indexHandle.db
      .prepare(`INSERT INTO rebuild_state(expected_chunks, skipped) VALUES (?, ?)`)
      .run(expectedChunks, skipped);
  });
  apply();

  return { chunks: expectedChunks, histories: historyWrites.length, skipped };
}
