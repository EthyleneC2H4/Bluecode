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
import path from "node:path";
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
  hasChunk,
  insertCasMeta,
  openDb,
  rebuildFromObjects,
  schemaMismatch,
  upsertHistory,
  type HeadroomDb,
} from "./store/db";
import { buildMatchQuery, insertChunk, searchChunks, type InsertChunkInput } from "./store/fts";
import { readMessageObject, renderProjection, writeMessageObject } from "./store/objects";
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
  const handle = openDb(path.join(dataDir, "index.db"));

  // Self-heal on startup: a foreign schema version or a corrupt fts index is
  // rebuilt from objects + cas_meta — objects are the source of truth.
  if (schemaMismatch(handle) || !ftsHealthy(handle)) {
    await rebuildFromObjects(dataDir, handle);
  }

  return {
    dataDir,
    compress: (params) => compress(handle, dataDir, params),
    retrieve: (params) => retrieve(handle, dataDir, params),
    sessionCount: () => countSessions(handle),
    close: () => handle.close(),
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
  handle: HeadroomDb,
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
      freedTokens: 0,
    };
  }

  const plan = await planArchive(handle, dataDir, projectId, sessionId, oldTurns, rawTokens);

  return {
    compacted: true,
    historyHash: plan.historyHashValue,
    summary: plan.summary,
    refs: plan.messages.map((message, i) => ({
      contentHash: plan.hashes[i] as string,
      role: message.info.role,
      turnIndex: turnIndexOf(plan.turns, i),
    })),
    replacedMessageIds: plan.messages.map((message) => message.info.id),
    rawTokens,
    summaryTokens: plan.summaryTokens,
    freedTokens: Math.max(0, rawTokens - plan.summaryTokens),
  };
}

/** Hash the old turns, then either reuse the stored summary or compute one. */
async function planArchive(
  handle: HeadroomDb,
  dataDir: string,
  projectId: string,
  sessionId: string,
  oldTurns: Turn[],
  rawTokens: number,
): Promise<ArchivePlan> {
  const messages = oldTurns.flatMap((turn) => turn.messages);
  const hashes: string[] = [];
  for (const message of messages) hashes.push(await hashMessage(message));
  const historyHashValue = await hashHistory(oldTurns);

  const existing = getHistory(handle, historyHashValue);
  if (existing !== null) {
    // Idempotent replay: reuse the stored summary verbatim.
    await backfill(handle, dataDir, projectId, sessionId, {
      turns: oldTurns,
      messages,
      hashes,
      historyHashValue,
    });
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

  // Objects first (CAS dedups; async outside any transaction), then ONE
  // transaction lands cas_meta + chunks/chunks_fts + histories together —
  // a crash before it leaves orphan objects only, which nothing indexes.
  for (const message of messages) await writeMessageObject(dataDir, message);

  const createdAt = Date.now();
  const write = handle.db.transaction(() => {
    writeRows(handle, plan, projectId, sessionId, createdAt);
    upsertHistory(
      handle,
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
  write();
  return plan;
}

interface RowFacts {
  turns: Turn[];
  messages: ChatMessage[];
  hashes: string[];
  historyHashValue: string;
}

/**
 * Repair pass for an already-known history whose rows are incomplete (crash
 * mid-archive of an older build, manual tampering).
 *
 * Commit-order invariant: rows are written strictly after every object of the
 * same archive is durably published, so "all chunk rows present" implies all
 * objects present — the steady-state replay costs N point lookups and ZERO
 * file I/O. Missing rows trigger a full-object rewrite (CAS dedups existing
 * ones) plus an idempotent row transaction.
 */
async function backfill(
  handle: HeadroomDb,
  dataDir: string,
  projectId: string,
  sessionId: string,
  facts: RowFacts,
): Promise<void> {
  let rowsComplete = true;
  for (const hash of facts.hashes) {
    if (!hasChunk(handle, hash)) {
      rowsComplete = false;
      break;
    }
  }
  if (rowsComplete) return;

  for (const message of facts.messages) await writeMessageObject(dataDir, message);

  const write = handle.db.transaction(() => {
    writeRows(handle, facts, projectId, sessionId, Date.now());
  });
  write();
}

/** cas_meta + chunk rows for the whole plan; idempotent (OR IGNORE / DEL+INS). */
function writeRows(
  handle: HeadroomDb,
  facts: RowFacts,
  projectId: string,
  sessionId: string,
  createdAt: number,
): void {
  // Flattened old-turn messages are contiguous in the input array starting at
  // the first old turn's startMsgIndex — that offset doubles as msg_seq.
  const seqBase = facts.turns[0]?.startMsgIndex ?? 0;
  for (let i = 0; i < facts.messages.length; i++) {
    insertCasMeta(handle, {
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
  for (const chunk of chunkInputs(facts, projectId, sessionId)) insertChunk(handle.db, chunk);
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
  handle: HeadroomDb,
  dataDir: string,
  params: HeadroomRetrieveParams,
): Promise<HeadroomRetrieveResult> {
  if ("hash" in params) {
    // Namespace ignored BY DESIGN: content is the address, so the hash itself
    // proves the caller already knew these exact archived bytes — there is
    // nothing to leak that the caller did not hold.
    const projection = await readMessageObject(dataDir, params.hash);
    if (projection === null) return { found: false };
    return { found: true, content: renderProjection(projection) };
  }

  // Unusable query text (no tokens left after quoting/segmentation) → no hits.
  const matchExpression = buildMatchQuery(params.query);
  if (matchExpression === null) return { hits: [] };
  return {
    hits: searchChunks(handle.db, params.namespace, matchExpression, params.limit ?? 5),
  };
}
