import { storageBytes, collectAbandonedTemps } from "./store/quota"
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
import { saveManifest, getView, setView, clearView } from "./store/manifests"
import { acquireWriterLease } from "./store/lease"
import { sha256Hex } from "@bluecode/shared"
import type { Namespace } from "@bluecode/contracts"
import { buildMemory } from "./memory"
import { mkdir } from "node:fs/promises"
import type {
  ChatMessage,
  HeadroomCompressParamsParsed,
  HeadroomCompressResult,
  HeadroomRetrieveParams,
  HeadroomRetrieveResult,
} from "@bluecode/contracts"
import { estimateTokens, paginateText, encodeCursor, decodeCursor } from "@bluecode/shared"
import {
  countSessions,
  ftsHealthy,
  getHistory,
  hasHistoryMeta,
  hasChunk,
  hasChunkRef,
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
} from "./store/db"
import { buildMatchQuery, insertChunk, searchChunks, type InsertChunkInput } from "./store/fts"
import { readMessageObject, renderProjection, writeMessageObject } from "./store/objects"
import { buildReplacementMessage, type CompactionPlan } from "./compaction"
import { hardenPath } from "./perms"
import {
  historySummary,
  keywords as keywordize,
  messageExcerpt,
  messageSummary,
  messageTokens,
} from "./summarize"
import {
  contentHash as hashMessage,
  historyHash as hashHistory,
  splitTurns,
  type Turn,
} from "./turns"

export interface EngineOptions {
  dataDir: string
  maxStorageBytes?: number
}

/** Mirrors retrieveByQueryParamsSchema's max(limit); see retrieve's clamp. */
const RETRIEVE_LIMIT_CAP = 50

export interface Engine {
  readonly dataDir: string
  compress(params: HeadroomCompressParamsParsed): Promise<HeadroomCompressResult>
  retrieve(params: HeadroomRetrieveParams): Promise<HeadroomRetrieveResult>
  /** Distinct namespaces archived so far (health metric). */
  sessionCount(): number
  getView(namespace: Namespace): HeadroomCompressResult | null
  setView(namespace: Namespace, plan: HeadroomCompressResult): void
  clearView(namespace: Namespace): void
  close(): void
}

export async function createEngine(options: EngineOptions): Promise<Engine> {
  const dataDir = options.dataDir
  await mkdir(dataDir, { recursive: true })
  // Cross-account hardening: the plugin may pass an explicit dataDir anywhere
  // (shared's defaultSidecarDataDir uid-namespaces only its OWN defaults), so
  // chmod regardless of how the dir got here. macOS tmpdirs are already
  // per-user; this closes Linux /tmp attach/bind/squat vectors no matter what
  // umask the spawning shell had. Best-effort: a chmod failure (root-owned
  // leftover, exotic mount) must not kill startup — see hardenPath.
  hardenPath(dataDir, 0o700)
  const lease = acquireWriterLease(dataDir)
  let store: HeadroomStore | undefined
  try {
    await collectAbandonedTemps(dataDir)
    store = openStore(dataDir)
    const openedStore = store

    // Self-heal on startup. The derived index is rebuilt from objects +
    // meta.cas_meta when it is corrupt, speaks a foreign schema version, or
    // looks lost (indexLooksLost: rows below the last rebuild's recorded
    // expectation, with a legacy fallback for fresh/deleted index.dbs — see
    // db.ts for why the naive chunks-vs-cas_meta comparison heal-thrashed).
    if (
      schemaMismatch(store.index) ||
      !ftsHealthy(store.index) ||
      indexLooksLost(store.index, store.meta)
    ) {
      const healed = await rebuildFromObjects(dataDir, store.meta, store.index)
      // A self-heal is an anomaly signal, not routine housekeeping — surface it
      // so divergence and heal-thrash regressions are diagnosable from logs.
      console.warn(
        `[headroomd] rebuilt derived index: ${healed.chunks} chunks, ${healed.histories} histories, ${healed.skipped} objects skipped`
      )
    }

    const maxStorageBytes = options.maxStorageBytes ?? 1024 * 1024 * 1024
    if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes <= 0)
      throw new Error("Invalid storage capacity")
    let tail: Promise<unknown> = Promise.resolve()
    let closed = false
    return {
      dataDir,
      getView: (ns) => getView(openedStore.meta, ns),
      setView: (ns, plan) => setView(openedStore.meta, ns, plan),
      clearView: (ns) => clearView(openedStore.meta, ns),
      compress: (params) => {
        if (closed) return Promise.reject(new Error("Engine closed"))
        const next = tail.then(() => compress(openedStore, dataDir, params, maxStorageBytes))
        tail = next.catch(() => {})
        return next
      },
      retrieve: (params) => retrieve(openedStore, dataDir, params),
      sessionCount: () => countSessions(openedStore.meta),
      close: () => {
        if (!closed) {
          closed = true
          openedStore.close()
          lease.close()
        }
      },
    }
  } catch (error) {
    store?.close()
    lease.close()
    throw error
  }
}

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

interface ArchivePlan {
  turns: Turn[]
  /** Flattened old-turn messages, aligned with `hashes`. */
  messages: ChatMessage[]
  hashes: string[]
  historyHashValue: string
  summary: string
  summaryTokens: number
}

async function compress(
  store: HeadroomStore,
  dataDir: string,
  params: HeadroomCompressParamsParsed,
  maxStorageBytes: number
): Promise<HeadroomCompressResult> {
  const { projectId, sessionId, messages, retainRecentTurns } = params

  const turns = splitTurns(messages)
  const tailCount = Math.min(retainRecentTurns + 1, turns.length)
  const candidateTurns = turns.slice(0, turns.length - Math.max(1, tailCount))
  const protectedIds = new Set(params.protectedMessageIds ?? [])
  const blocked = candidateTurns.findIndex((turn) =>
    turn.messages.some(
      (m) =>
        m.protected ||
        protectedIds.has(m.info.id) ||
        m.parts.some(
          (p) =>
            p.type === "tool" &&
            !["completed", "error", "ok", "success", "failed"].includes(p.state.status)
        )
    )
  )
  const oldTurns = blocked < 0 ? candidateTurns : candidateTurns.slice(0, blocked)

  // rawTokens covers ALL input messages (retained tail included): it is the
  // pre-compression context size the plugin compares against its watermark.
  const rawTokens = messages.reduce((sum, message) => sum + messageTokens(message), 0)

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
    }
  }

  let plan = await planArchive(store, oldTurns)
  const targetTokens = params.targetTokens ?? Math.floor(params.contextWindowTokens * 0.55)
  {
    for (let count = 1; count <= oldTurns.length; count++) {
      const candidate = await planArchive(store, oldTurns.slice(0, count))
      const evicted = candidate.messages.reduce((sum, m) => sum + messageTokens(m), 0)
      const replacement = messageTokens(
        buildReplacementMessage({
          historyHash: candidate.historyHashValue,
          summary: candidate.summary,
          refs: [],
          replacedMessageIds: [],
          memory: buildMemory(candidate.messages),
        })
      )
      const gain = evicted - replacement
      if (gain > 0) {
        plan = candidate
      }
      if (gain > 0 && rawTokens - gain <= targetTokens) {
        plan = candidate
        break
      }
    }
  }
  const evictedTokensEst = plan.messages.reduce((sum, message) => sum + messageTokens(message), 0)
  const retainedTokensEst = rawTokens - evictedTokensEst
  const refs = plan.messages.map((message, i) => ({
    contentHash: plan.hashes[i] as string,
    role: message.info.role,
    turnIndex: turnIndexOf(plan.turns, i),
  }))
  const replacementPlan: CompactionPlan = {
    historyHash: plan.historyHashValue,
    summary: plan.summary,
    refs,
    replacedMessageIds: plan.messages.map((message) => message.info.id),
    sourceDigests: plan.hashes,
    memory: buildMemory(plan.messages),
    ...(params.epoch !== undefined ? { epoch: params.epoch } : {}),
  }
  const replacementTokensEst = messageTokens(buildReplacementMessage(replacementPlan))
  const finalTokensEst = retainedTokensEst + replacementTokensEst
  const freedTokens = rawTokens - finalTokensEst

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
    }
  }

  // Serialize compress calls and reserve a conservative upper bound for CAS, both
  // SQLite files/WAL pages, memory and indexes before publishing any reference.
  if (!hasHistoryMeta(store.meta, { projectId, sessionId }, plan.historyHashValue)) {
    const reserve = Buffer.byteLength(JSON.stringify(plan.messages)) * 16 + 256 * 1024
    if ((await storageBytes(dataDir)) + reserve > maxStorageBytes)
      throw new Error("Headroom storage capacity exceeded")
  }
  await persistArchive(store, dataDir, projectId, sessionId, plan, rawTokens)

  const result: HeadroomCompressResult = {
    compacted: true,
    budgetExceeded: finalTokensEst > targetTokens,
    historyHash: plan.historyHashValue,
    summary: plan.summary,
    refs,
    replacedMessageIds: plan.messages.map((message) => message.info.id),
    sourceDigests: plan.hashes,
    memory: buildMemory(plan.messages),
    ...(params.epoch !== undefined ? { epoch: params.epoch } : {}),
    rawTokens,
    summaryTokens: plan.summaryTokens,
    sourceTokensEst: rawTokens,
    evictedTokensEst,
    retainedTokensEst,
    replacementTokensEst,
    finalTokensEst,
    freedTokens,
  }
  saveManifest(
    store.meta,
    { projectId, sessionId },
    result,
    plan.messages.flatMap((m) => (m.archive ? [m.archive.historyHash] : []))
  )
  return result
}

/** Hash the old turns, then either reuse the stored summary or compute one. */
async function planArchive(store: HeadroomStore, oldTurns: Turn[]): Promise<ArchivePlan> {
  const messages = oldTurns.flatMap((turn) => turn.messages)
  const hashes: string[] = []
  for (const message of messages) {
    hashes.push(await hashMessage(message))
  }
  const historyHashValue = await hashHistory(oldTurns)

  const summary = historySummary(oldTurns)
  const plan: ArchivePlan = {
    turns: oldTurns,
    messages,
    hashes,
    historyHashValue,
    summary,
    summaryTokens: estimateTokens(summary),
  }

  return plan
}

async function persistArchive(
  store: HeadroomStore,
  dataDir: string,
  projectId: string,
  sessionId: string,
  plan: ArchivePlan,
  rawTokens: number
): Promise<void> {
  const existing = getHistory(store.index, plan.historyHashValue)
  if (existing !== null) {
    await backfill(store, dataDir, projectId, sessionId, plan)
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
      Date.now()
    )
    return
  }

  // Write order (each step idempotent, crash-safe):
  //   objects -> meta.cas_meta -> index rows.
  // A crash anywhere leaves earlier steps only; attribution leading the
  // derived index is repairable (startup heal / replay backfill), the
  // reverse would not be. The two databases cannot share one transaction,
  // so ordering IS the atomicity story here. Objects are addressed by their
  // logical contentHash — the same value cas_meta and refs carry.
  for (let i = 0; i < plan.messages.length; i++) {
    await writeMessageObject(dataDir, plan.messages[i] as ChatMessage, plan.hashes[i] as string)
  }

  const createdAt = Date.now()
  const writeMeta = store.meta.db.transaction(() => {
    insertCasMetaRows(store.meta, factsOf(plan), projectId, sessionId, createdAt)
  })
  writeMeta()

  const writeIndex = store.index.db.transaction(() => {
    writeDerivedRows(store.index, plan, projectId, sessionId, createdAt)
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
      createdAt
    )
  })
  writeIndex()
}

interface RowFacts {
  turns: Turn[]
  messages: ChatMessage[]
  hashes: string[]
  historyHashValue: string
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
  facts: RowFacts
): Promise<void> {
  const namespace = { projectId, sessionId }
  const metaRows = listHistoryMeta(
    store.meta,
    namespace,
    facts.historyHashValue,
    0,
    facts.hashes.length + 1
  )
  let rowsComplete =
    metaRows.length === facts.hashes.length &&
    metaRows.every((row, index) => row.hash === facts.hashes[index])
  for (const hash of facts.hashes) {
    if (
      !hasChunk(store.index, hash) ||
      !hasChunkRef(store.index, namespace, facts.historyHashValue, hash)
    ) {
      rowsComplete = false
      break
    }
  }
  // Revalidate source objects before acknowledging even a replay.
  void rowsComplete

  for (let i = 0; i < facts.messages.length; i++) {
    await writeMessageObject(dataDir, facts.messages[i] as ChatMessage, facts.hashes[i] as string)
  }

  const createdAt = Date.now()
  const writeMeta = store.meta.db.transaction(() => {
    insertCasMetaRows(store.meta, facts, projectId, sessionId, createdAt)
  })
  writeMeta()
  const writeIndex = store.index.db.transaction(() => {
    writeDerivedRows(store.index, facts, projectId, sessionId, createdAt)
  })
  writeIndex()
}

function factsOf(plan: ArchivePlan): RowFacts {
  return plan
}

/** cas_meta rows only (meta.db side); idempotent via OR IGNORE. */
function insertCasMetaRows(
  meta: HeadroomDb,
  facts: RowFacts,
  projectId: string,
  sessionId: string,
  createdAt: number
): void {
  // Flattened old-turn messages are contiguous in the input array starting at
  // the first old turn's startMsgIndex — that offset doubles as msg_seq.
  const seqBase = facts.turns[0]?.startMsgIndex ?? 0
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
    })
  }
}

/** chunks/chunks_fts rows only (index.db side); idempotent DEL+INS. */
function writeDerivedRows(
  index: HeadroomDb,
  facts: RowFacts,
  projectId: string,
  sessionId: string,
  createdAt: number
): void {
  void createdAt
  for (const chunk of chunkInputs(facts, projectId, sessionId)) insertChunk(index.db, chunk)
}

/** Turn owning the flattened message at `flatIndex` (last turn as fallback). */
function turnIndexOf(turns: Turn[], flatIndex: number): number {
  let cursor = 0
  for (const turn of turns) {
    cursor += turn.messages.length
    if (flatIndex < cursor) return turn.index
  }
  return (turns[turns.length - 1] as Turn | undefined)?.index ?? 0
}

/** Index-row inputs; column math must mirror rebuildFromObjects exactly. */
function chunkInputs(facts: RowFacts, projectId: string, sessionId: string): InsertChunkInput[] {
  return facts.messages.map((message, i) => {
    const summaryText = messageSummary(message)
    const rawExcerpt = messageExcerpt(message)
    return {
      contentHash: facts.hashes[i] as string,
      projectId,
      sessionId,
      role: message.info.role,
      turnIndex: turnIndexOf(facts.turns, i),
      historyHash: facts.historyHashValue,
      summaryText,
      rawExcerpt,
      fullText: renderProjection(message),
      keywords: keywordize(`${summaryText} ${rawExcerpt}`),
    }
  })
}

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

async function retrieve(
  store: HeadroomStore,
  dataDir: string,
  params: HeadroomRetrieveParams
): Promise<HeadroomRetrieveResult> {
  paginateText("", {
    ref: "budget-validation",
    maxBytes: params.maxBytes,
    maxTokens: params.maxTokens,
  })
  if ("hash" in params) {
    const ref = JSON.stringify([params.namespace, params.hash])
    decodeCursor(params.cursor, ref)
    if (!ownsCasMeta(store.meta, params.namespace, params.hash)) return { found: false }
    const projection = await readMessageObject(dataDir, params.hash)
    if (projection === null) return { found: false }
    return { found: true, ...paginateText(renderProjection(projection), { ...params, ref }) }
  }

  if ("historyHash" in params) {
    if (!hasHistoryMeta(store.meta, params.namespace, params.historyHash)) {
      return { found: false }
    }
    const ref = JSON.stringify([params.namespace, params.historyHash])
    // Encode message ordinal and intra-message position in a reference-bound outer cursor.
    let offset = params.offset ?? 0,
      intra = 0
    if (params.cursor) {
      const split = params.cursor.split(".")
      if (split.length !== 2) throw new Error("Invalid history cursor")
      offset = decodeCursor(split[0], ref)
      intra = decodeCursor(split[1], `${ref}:${offset}`)
    }
    const limits = paginateText("", { ref, maxBytes: params.maxBytes, maxTokens: params.maxTokens })
    void limits
    let budget = Math.min(params.maxBytes ?? 32768, 131072, params.maxTokens ?? 2048, 8192)
    const limit = Math.min(params.limit ?? 10, RETRIEVE_LIMIT_CAP)
    const items: Array<{
      contentHash: string
      role: "user" | "assistant"
      turnIndex: number
      content: string
    }> = []
    const missingHashes: string[] = []
    let count = 0,
      more = false
    const iterator = historyLeaves(store, dataDir, params.namespace, params.historyHash)
    for (let skipped = 0; skipped < offset; skipped++) if ((await iterator.next()).done) break
    let current = await iterator.next()
    while (count < limit && budget > 0) {
      if (current.done) {
        if (intra) throw new Error("Cursor outside history")
        break
      }
      const { row, projection } = current.value
      if (!projection) {
        missingHashes.push(row.hash)
        offset++
        intra = 0
        count++
        current = await iterator.next()
        continue
      }
      let page
      try {
        page = paginateText(renderProjection(projection), {
          ref: row.hash,
          cursor: encodeCursor(row.hash, intra),
          maxBytes: budget,
          maxTokens: budget,
        })
      } catch (error) {
        if (items.length > 0) break
        throw error
      }
      items.push({
        contentHash: row.hash,
        role: row.role,
        turnIndex: row.turnIndex,
        content: page.content,
      })
      budget -= page.bytes
      count++
      if (page.nextCursor) {
        intra = decodeCursor(page.nextCursor, row.hash)
        more = true
        break
      }
      offset++
      intra = 0
      current = await iterator.next()
    }
    more = more || !current.done
    await iterator.return(undefined)
    return {
      found: true,
      items,
      nextOffset: more ? offset : null,
      nextCursor: more
        ? `${encodeCursor(ref, offset)}.${encodeCursor(`${ref}:${offset}`, intra)}`
        : null,
      truncated: more,
      partial: missingHashes.length > 0,
      missingHashes,
    }
  }

  // Unusable query text (no tokens left after quoting/segmentation) → no hits.
  const matchExpression = buildMatchQuery(params.query)
  if (matchExpression === null) return { hits: [] }
  const all = searchChunks(
    store.index.db,
    params.namespace,
    matchExpression,
    Math.min(params.limit ?? 5, RETRIEVE_LIMIT_CAP)
  )
  const snapshot = await sha256Hex(
    JSON.stringify(
      all.map(({ hash, chunkId, startOffset, endOffset, snippet }) => ({
        hash,
        chunkId,
        startOffset,
        endOffset,
        snippet,
      }))
    )
  )
  const ref = JSON.stringify([params.namespace, params.query, params.limit ?? 5, snapshot])
  const pieces = params.cursor?.split(".")
  if (pieces && pieces.length !== 2) throw new Error("Invalid query cursor")
  let offset = pieces ? decodeCursor(pieces[0], ref) : 0
  let intra = pieces ? decodeCursor(pieces[1], `${ref}:${offset}`) : 0
  paginateText("", { ref, maxBytes: params.maxBytes, maxTokens: params.maxTokens })
  let budget = Math.min(params.maxBytes ?? 32768, 131072, params.maxTokens ?? 2048, 8192)
  if (offset > all.length || (offset === all.length && intra > 0))
    throw new Error("Cursor outside query results")
  const hits = []
  while (offset < all.length && budget > 0) {
    const hit = all[offset]!
    let page
    try {
      page = paginateText(hit.snippet, {
        ref: hit.hash,
        cursor: encodeCursor(hit.hash, intra),
        maxBytes: budget,
        maxTokens: budget,
      })
    } catch (error) {
      if (hits.length > 0) break
      throw error
    }
    const startOffset = hit.startOffset + intra
    hits.push({
      ...hit,
      snippet: page.content,
      startOffset,
      endOffset: startOffset + page.content.length,
    })
    budget -= page.bytes
    if (page.nextCursor) {
      intra = decodeCursor(page.nextCursor, hit.hash)
      break
    }
    offset++
    intra = 0
  }
  return {
    hits,
    nextCursor:
      offset < all.length
        ? `${encodeCursor(ref, offset)}.${encodeCursor(`${ref}:${offset}`, intra)}`
        : null,
    truncated: offset < all.length,
  }
}

/** Missing, unreadable or logically mismatched objects are never returned. */
async function readValidProjection(dataDir: string, hash: string) {
  try {
    const projection = await readMessageObject(dataDir, hash)
    if (projection === null) return null
    // readMessageObject validates schema and the version-appropriate digest.
    return projection
  } catch {
    return null
  }
}

/** Recursively expand confirmed child archives in namespace order, without retaining whole histories. */
async function* historyLeaves(
  store: HeadroomStore,
  dataDir: string,
  namespace: Namespace,
  hash: string,
  ancestors = new Set<string>()
): AsyncGenerator<{
  row: ReturnType<typeof listHistoryMeta>[number]
  projection: Awaited<ReturnType<typeof readValidProjection>>
}> {
  if (ancestors.has(hash) || ancestors.size >= 128) throw new Error("Invalid archive lineage")
  const lineage = new Set(ancestors)
  lineage.add(hash)
  for (let offset = 0; ; offset++) {
    const row = listHistoryMeta(store.meta, namespace, hash, offset, 1)[0]
    if (!row) return
    const projection = await readValidProjection(dataDir, row.hash)
    const child = projection?.archive?.historyHash
    if (
      child &&
      projection?.info.id === `compaction-${child}` &&
      hasHistoryMeta(store.meta, namespace, child)
    ) {
      yield* historyLeaves(store, dataDir, namespace, child, lineage)
    } else yield { row, projection }
  }
}
