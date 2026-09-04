/**
 * headroomd business layer: compress archives the turns being evicted into
 * CAS objects + the SQLite/FTS index and returns a deterministic summary;
 * retrieve answers by-hash round-trips and by-query BM25 lookups.
 *
 * compress is IDEMPOTENT: identical input yields an identical historyHash,
 * a repeat call reuses the stored summary (histories PK hit) instead of
 * recomputing it, and object writes dedup at the CAS layer. Steady-state
 * replays touch neither files nor rows — see `backfill`.
 *
 * triggerRatio is validated by the contract schema but deliberately does NOT
 * influence any decision here: watermark monitoring lives plugin-side in this
 * version. The field rides along for forward compatibility only.
 */
import { mkdir } from "node:fs/promises";
import type {
  ChatMessage,
  HeadroomCompressParamsParsed,
  HeadroomCompressResult,
  HeadroomRetrieveParams,
  HeadroomRetrieveResult,
} from "@bluecode/contracts";
import { estimateTokens } from "@bluecode/shared";
import {
  countSessions,
  ftsHealthy,
  getHistory,
  hasHistoryMeta,
  hasChunk,
  indexLooksLost,
  insertCasMeta,
  listHistoryMeta,
  openStore,
  ownsCasMeta,
  rebuildFromObjects,
  schemaMismatch,
  upsertHistory,
  type HeadroomDb,
  type HeadroomStore,
} from "./store/db";
import { buildMatchQuery, insertChunk, searchChunks, type InsertChunkInput } from "./store/fts";
import { readMessageObject, renderProjection, writeMessageObject } from "./store/objects";
import { buildReplacementMessage, type CompactionPlan } from "./compaction";
import { hardenPath } from "./perms";
import {
  historySummary,
  keywords as keywordize,
  messageExcerpt,
  messageSummary,
  messageTokens,
} from "./summarize";
import {
  contentHash as hashMessage,
  historyHash as hashHistory,
  splitTurns,
  type Turn,
} from "./turns";

export interface EngineOptions {
  dataDir: string;
}

/** Mirrors retrieveByQueryParamsSchema's max(limit); see retrieve's clamp. */
const RETRIEVE_LIMIT_CAP = 50;

export interface Engine {
  readonly dataDir: string;
  compress(params: HeadroomCompressParamsParsed): Promise<HeadroomCompressResult>;
  retrieve(params: HeadroomRetrieveParams): Promise<HeadroomRetrieveResult>;
  /** Distinct namespaces archived so far (health metric). */
  sessionCount(): number;
  close(): void;
}

export async function createEngine(options: EngineOptions): Promise<Engine> {
  const dataDir = options.dataDir;
  await mkdir(dataDir, { recursive: true });
  // Cross-account hardening: the plugin may pass an explicit dataDir anywhere
  // (shared's defaultSidecarDataDir uid-namespaces only its OWN defaults), so
  // chmod regardless of how the dir got here. macOS tmpdirs are already
  // per-user; this closes Linux /tmp attach/bind/squat vectors no matter what
  // umask the spawning shell had. Best-effort: a chmod failure (root-owned
  // leftover, exotic mount) must not kill startup — see hardenPath.
  hardenPath(dataDir, 0o700);
  const store = openStore(dataDir);

  // Self-heal on startup. The derived index is rebuilt from objects +
  // meta.cas_meta when it is corrupt, speaks a foreign schema version, or
  // looks lost (indexLooksLost: rows below the last rebuild's recorded
  // expectation, with a legacy fallback for fresh/deleted index.dbs — see
  // db.ts for why the naive chunks-vs-cas_meta comparison heal-thrashed).
  if (schemaMismatch(store.index) || !ftsHealthy(store.index) || indexLooksLost(store.index, store.meta)) {
    const healed = await rebuildFromObjects(dataDir, store.meta, store.index);
    // A self-heal is an anomaly signal, not routine housekeeping — surface it
    // so divergence and heal-thrash regressions are diagnosable from logs.
    console.warn(
      `[headroomd] rebuilt derived index: ${healed.chunks} chunks, ${healed.histories} histories, ${healed.skipped} objects skipped`,
    );
  }

  return {
    dataDir,
    compress: (params) => compress(store, dataDir, params),
    retrieve: (params) => retrieve(store, dataDir, params),
    sessionCount: () => countSessions(store.meta),
    close: () => store.close(),
  };
}

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

interface ArchivePlan {
  turns: Turn[];
  /** Flattened old-turn messages, aligned with `hashes`. */
  messages: ChatMessage[];
  hashes: string[];
  historyHashValue: string;
  summary: string;
  summaryTokens: number;
}

async function compress(
  store: HeadroomStore,
  dataDir: string,
  params: HeadroomCompressParamsParsed,
): Promise<HeadroomCompressResult> {
  const { projectId, sessionId, messages, retainRecentTurns } = params;

  const turns = splitTurns(messages);
  const tailCount = Math.min(retainRecentTurns, turns.length);
  const oldTurns = turns.slice(0, turns.length - tailCount);

  // rawTokens covers ALL input messages (retained tail included): it is the
  // pre-compression context size the plugin compares against its watermark.
  const rawTokens = messages.reduce((sum, message) => sum + messageTokens(message), 0);

  if (oldTurns.length === 0) {
    // Nothing to compact: fully inert result (contract refine enforces this).
    return {
      compacted: false,
      historyHash: null,
      summary: null,
      refs: [],
      replacedMessageIds: [],
      rawTokens,
      summaryTokens: 0,
      sourceTokensEst: rawTokens,
      evictedTokensEst: 0,
      retainedTokensEst: rawTokens,
      replacementTokensEst: 0,
      finalTokensEst: rawTokens,
      freedTokens: 0,
    };
  }

  const plan = await planArchive(store, oldTurns);
  const evictedTokensEst = plan.messages.reduce(
    (sum, message) => sum + messageTokens(message),
    0,
  );
  const retainedTokensEst = rawTokens - evictedTokensEst;
  const refs = plan.messages.map((message, i) => ({
    contentHash: plan.hashes[i] as string,
    role: message.info.role,
    turnIndex: turnIndexOf(plan.turns, i),
  }));
  const replacementPlan: CompactionPlan = {
    historyHash: plan.historyHashValue,
    summary: plan.summary,
    refs,
    replacedMessageIds: plan.messages.map((message) => message.info.id),
  };
  const replacementTokensEst = messageTokens(buildReplacementMessage(replacementPlan));
  const finalTokensEst = retainedTokensEst + replacementTokensEst;
  const freedTokens = rawTokens - finalTokensEst;

  // Archiving is inert unless the actual replacement plus retained tail is
  // smaller than the source. No object or database row is written here.
  if (freedTokens <= 0) {
    return {
      compacted: false,
      historyHash: null,
      summary: null,
      refs: [],
      replacedMessageIds: [],
      rawTokens,
      summaryTokens: 0,
      sourceTokensEst: rawTokens,
      evictedTokensEst: 0,
      retainedTokensEst: rawTokens,
      replacementTokensEst: 0,
      finalTokensEst: rawTokens,
      freedTokens: 0,
    };
  }

  await persistArchive(store, dataDir, projectId, sessionId, plan, rawTokens);

  return {
    compacted: true,
    historyHash: plan.historyHashValue,
    summary: plan.summary,
    refs,
    replacedMessageIds: plan.messages.map((message) => message.info.id),
    rawTokens,
    summaryTokens: plan.summaryTokens,
    sourceTokensEst: rawTokens,
    evictedTokensEst,
    retainedTokensEst,
    replacementTokensEst,
    finalTokensEst,
    freedTokens,
  };
}

/** Hash the old turns, then either reuse the stored summary or compute one. */
async function planArchive(
  store: HeadroomStore,
  oldTurns: Turn[],
): Promise<ArchivePlan> {
  const messages = oldTurns.flatMap((turn) => turn.messages);
  const hashes: string[] = [];
  for (const message of messages) hashes.push(await hashMessage(message));
  const historyHashValue = await hashHistory(oldTurns);

  const existing = getHistory(store.index, historyHashValue);
  if (existing !== null) {
    return {
      turns: oldTurns,
      messages,
      hashes,
      historyHashValue,
      summary: existing.summary,
      summaryTokens: existing.summaryTokens,
    };
  }

  const summary = historySummary(oldTurns);
  const plan: ArchivePlan = {
    turns: oldTurns,
    messages,
    hashes,
    historyHashValue,
    summary,
    summaryTokens: estimateTokens(summary),
  };

  return plan;
}

async function persistArchive(
  store: HeadroomStore,
  dataDir: string,
  projectId: string,
  sessionId: string,
  plan: ArchivePlan,
  rawTokens: number,
): Promise<void> {
  const existing = getHistory(store.index, plan.historyHashValue);
  if (existing !== null) {
    await backfill(store, dataDir, projectId, sessionId, plan);
    return;
  }

  // Write order (each step idempotent, crash-safe):
  //   objects -> meta.cas_meta -> index rows.
  // A crash anywhere leaves earlier steps only; attribution leading the
  // derived index is repairable (startup heal / replay backfill), the
  // reverse would not be. The two databases cannot share one transaction,
  // so ordering IS the atomicity story here. Objects are addressed by their
  // logical contentHash — the same value cas_meta and refs carry.
  for (let i = 0; i < plan.messages.length; i++) {
    await writeMessageObject(
      dataDir,
      plan.messages[i] as ChatMessage,
      plan.hashes[i] as string,
    );
  }

  const createdAt = Date.now();
  const writeMeta = store.meta.db.transaction(() => {
    insertCasMetaRows(store.meta, factsOf(plan), projectId, sessionId, createdAt);
  });
  writeMeta();

  const writeIndex = store.index.db.transaction(() => {
    writeDerivedRows(store.index, plan, projectId, sessionId, createdAt);
    upsertHistory(
      store.index,
      {
        historyHash: plan.historyHashValue,
        projectId,
        sessionId,
        summary: plan.summary,
        rawTokens,
        summaryTokens: plan.summaryTokens,
      },
      createdAt,
    );
  });
  writeIndex();
}

interface RowFacts {
  turns: Turn[];
  messages: ChatMessage[];
  hashes: string[];
  historyHashValue: string;
}

/**
 * Repair pass for an already-known history whose index rows are incomplete
 * (crash between the meta and index transactions, manual tampering).
 *
 * Commit-order invariant: index rows are written strictly after every object
 * of the same archive is durably published, so "all chunk rows present"
 * implies all objects present — the steady-state replay costs N point
 * lookups and ZERO file I/O. Missing rows trigger a full-object rewrite
 * (CAS dedups existing ones) plus idempotent row transactions.
 */
async function backfill(
  store: HeadroomStore,
  dataDir: string,
  projectId: string,
  sessionId: string,
  facts: RowFacts,
): Promise<void> {
  let rowsComplete = true;
  for (const hash of facts.hashes) {
    if (!hasChunk(store.index, hash)) {
      rowsComplete = false;
      break;
    }
  }
  if (rowsComplete) return;

  for (let i = 0; i < facts.messages.length; i++) {
    await writeMessageObject(dataDir, facts.messages[i] as ChatMessage, facts.hashes[i] as string);
  }

  const createdAt = Date.now();
  const writeMeta = store.meta.db.transaction(() => {
    insertCasMetaRows(store.meta, facts, projectId, sessionId, createdAt);
  });
  writeMeta();
  const writeIndex = store.index.db.transaction(() => {
    writeDerivedRows(store.index, facts, projectId, sessionId, createdAt);
  });
  writeIndex();
}

function factsOf(plan: ArchivePlan): RowFacts {
  return plan;
}

/** cas_meta rows only (meta.db side); idempotent via OR IGNORE. */
function insertCasMetaRows(
  meta: HeadroomDb,
  facts: RowFacts,
  projectId: string,
  sessionId: string,
  createdAt: number,
): void {
  // Flattened old-turn messages are contiguous in the input array starting at
  // the first old turn's startMsgIndex — that offset doubles as msg_seq.
  const seqBase = facts.turns[0]?.startMsgIndex ?? 0;
  for (let i = 0; i < facts.messages.length; i++) {
    insertCasMeta(meta, {
      hash: facts.hashes[i] as string,
      projectId,
      sessionId,
      role: (facts.messages[i] as ChatMessage).info.role,
      turnIndex: turnIndexOf(facts.turns, i),
      msgSeq: seqBase + i,
      historyHash: facts.historyHashValue,
      createdAt,
    });
  }
}

/** chunks/chunks_fts rows only (index.db side); idempotent DEL+INS. */
function writeDerivedRows(
  index: HeadroomDb,
  facts: RowFacts,
  projectId: string,
  sessionId: string,
  createdAt: number,
): void {
  void createdAt;
  for (const chunk of chunkInputs(facts, projectId, sessionId)) insertChunk(index.db, chunk);
}

/** Turn owning the flattened message at `flatIndex` (last turn as fallback). */
function turnIndexOf(turns: Turn[], flatIndex: number): number {
  let cursor = 0;
  for (const turn of turns) {
    cursor += turn.messages.length;
    if (flatIndex < cursor) return turn.index;
  }
  return (turns[turns.length - 1] as Turn | undefined)?.index ?? 0;
}

/** Index-row inputs; column math must mirror rebuildFromObjects exactly. */
function chunkInputs(facts: RowFacts, projectId: string, sessionId: string): InsertChunkInput[] {
  return facts.messages.map((message, i) => {
    const summaryText = messageSummary(message);
    const rawExcerpt = messageExcerpt(message);
    return {
      contentHash: facts.hashes[i] as string,
      projectId,
      sessionId,
      role: message.info.role,
      turnIndex: turnIndexOf(facts.turns, i),
      historyHash: facts.historyHashValue,
      summaryText,
      rawExcerpt,
      keywords: keywordize(`${summaryText} ${rawExcerpt}`),
    };
  });
}

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

async function retrieve(
  store: HeadroomStore,
  dataDir: string,
  params: HeadroomRetrieveParams,
): Promise<HeadroomRetrieveResult> {
  if ("hash" in params) {
    if (!ownsCasMeta(store.meta, params.namespace, params.hash)) return { found: false };
    const projection = await readValidProjection(dataDir, params.hash);
    if (projection === null) return { found: false };
    return { found: true, content: renderProjection(projection) };
  }

  if ("historyHash" in params) {
    if (!hasHistoryMeta(store.meta, params.namespace, params.historyHash)) {
      return { found: false };
    }
    const offset = params.offset ?? 0;
    const limit = Math.min(params.limit ?? 10, RETRIEVE_LIMIT_CAP);
    const rows = listHistoryMeta(
      store.meta,
      params.namespace,
      params.historyHash,
      offset,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items: Array<{
      contentHash: string;
      role: "user" | "assistant";
      turnIndex: number;
      content: string;
    }> = [];
    const missingHashes: string[] = [];
    for (const row of pageRows) {
      const projection = await readValidProjection(dataDir, row.hash);
      if (projection === null) {
        missingHashes.push(row.hash);
        continue;
      }
      items.push({
        contentHash: row.hash,
        role: row.role,
        turnIndex: row.turnIndex,
        content: renderProjection(projection),
      });
    }
    return {
      found: true,
      items,
      nextOffset: hasMore ? offset + limit : null,
      partial: missingHashes.length > 0,
      missingHashes,
    };
  }

  // Unusable query text (no tokens left after quoting/segmentation) → no hits.
  const matchExpression = buildMatchQuery(params.query);
  if (matchExpression === null) return { hits: [] };
  return {
    // Defense-in-depth against schema drift: contracts cap limit at 50, but
    // direct UDS clients bypass the plugin tool, so clamp here too — one
    // unbounded query must not dump the whole archive into model context.
    hits: searchChunks(
      store.index.db,
      params.namespace,
      matchExpression,
      Math.min(params.limit ?? 5, RETRIEVE_LIMIT_CAP),
    ),
  };
}

/** Missing, unreadable or logically mismatched objects are never returned. */
async function readValidProjection(dataDir: string, hash: string) {
  try {
    const projection = await readMessageObject(dataDir, hash);
    if (projection === null) return null;
    if ((await hashMessage(projection)) !== hash) return null;
    return projection;
  } catch {
    return null;
  }
}
