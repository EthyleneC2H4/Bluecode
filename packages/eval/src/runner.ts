/** Four-group evaluation runner over the real RTK and Headroomd pipelines. */
import { RtkClient, type CompressInput } from "@bluecode/rtk"
import {
  HeadroomClient,
  materializeCompaction,
  type HeadroomClientOptions,
} from "@bluecode/headroomd"
import type {
  ChatMessage,
  HeadroomCompressResult,
  RetrieveByHistoryResult,
} from "@bluecode/contracts"
import { createExactTokenCounter } from "@bluecode/shared"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  allFixtures,
  quickFixtures,
  fixturesToHeadroomParams,
  type FixtureSample,
} from "./fixtures"
import {
  buildPerFixtureRecord,
  evaluateRecall,
  type DegradedCounts,
  type EvalGroup,
  type LatencySample,
  type PerFixtureRecord,
  type RecallResult,
} from "./metrics"

const tokenCounter = createExactTokenCounter()
const DEFAULT_HEADROOM_ENTRY = path.resolve(import.meta.dir, "../../headroomd/src/bin.ts")
// Connect-or-spawn's first retry is at 250ms, so the daemon must outlive it.
const HEADROOM_IDLE_EXIT_MS = 1000

export type EvaluationObservation =
  | { type: "data-dir"; dataDir: string; temporary: boolean }
  | {
      type: "headroom-input"
      group: "C" | "D"
      fixture: string
      messages: ChatMessage[]
    }
  | {
      type: "final-context"
      group: EvalGroup
      fixture: string
      messages: ChatMessage[]
      text: string
      outTokens: number
    }

export interface RunnerOptions {
  quick?: boolean
  dataDir?: string
  rtkEntry?: string
  headroomEntry?: string
  rtkBudgetTokens?: number
  rtkTimeoutMs?: number
  rtkMinBytes?: number
  headroomTimeoutMs?: number
  contextWindowTokens?: number
  observe?: (event: EvaluationObservation) => void
}

export interface RunnerResult {
  perFixture: PerFixtureRecord[]
  latencies: LatencySample[]
  recallResults: RecallResult[]
  dataDir: string
  temporaryDataDir: boolean
}

interface GroupResult {
  perFixture: PerFixtureRecord[]
  latencies: LatencySample[]
  recallResults: RecallResult[]
}

type DegradedReason = keyof DegradedCounts

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return structuredClone(messages)
}

/** Real OpenCode message IDs are globally unique; fixture clones must model that invariant. */
function cloneMessagesForSession(messages: ChatMessage[], sessionId: string): ChatMessage[] {
  const cloned = cloneMessages(messages)
  for (const message of cloned) message.info.id = `${sessionId}:${message.info.id}`
  return cloned
}

function extractAllText(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text") parts.push(part.text)
      else if (typeof part.state.output === "string") parts.push(part.state.output)
    }
  }
  return parts.join("\n")
}

function observeFinal(
  options: RunnerOptions,
  group: EvalGroup,
  fixture: string,
  messages: ChatMessage[],
  text: string,
): void {
  options.observe?.({
    type: "final-context",
    group,
    fixture,
    messages: cloneMessages(messages),
    text,
    outTokens: tokenCounter.count(text),
  })
}

function rtkOptions(options: RunnerOptions, dataDir: string) {
  return {
    cwd: process.cwd(),
    dataDir,
    testMode: true,
    ...(options.rtkEntry !== undefined ? { entry: options.rtkEntry } : {}),
    ...(options.rtkBudgetTokens !== undefined
      ? { budgetTokens: options.rtkBudgetTokens }
      : {}),
    ...(options.rtkTimeoutMs !== undefined ? { timeoutMs: options.rtkTimeoutMs } : {}),
    ...(options.rtkMinBytes !== undefined ? { minBytes: options.rtkMinBytes } : {}),
  }
}

function headroomOptions(options: RunnerOptions, dataDir: string): HeadroomClientOptions {
  return {
    dataDir,
    ...(options.headroomTimeoutMs !== undefined
      ? { timeoutMs: options.headroomTimeoutMs }
      : {}),
    spawn: {
      entry: options.headroomEntry ?? DEFAULT_HEADROOM_ENTRY,
      cwd: process.cwd(),
      args: [
        "--dataDir",
        dataDir,
        "--idleExitMs",
        String(HEADROOM_IDLE_EXIT_MS),
      ],
    },
  }
}

interface RtkRewriteResult {
  messages: ChatMessage[]
  archivedHashes: string[]
  degradedReason: DegradedReason | null
  latencyMs: number
}

async function rewriteToolParts(
  rtk: RtkClient,
  source: ChatMessage[],
  sessionId: string,
): Promise<RtkRewriteResult> {
  const messages = cloneMessages(source)
  const archivedHashes: string[] = []
  let degradedReason: DegradedReason | null = null
  let callIndex = 0
  const started = performance.now()

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || typeof part.state.output !== "string") continue
      const input: CompressInput = {
        tool: part.tool,
        output: part.state.output,
        sessionId,
        callId: `call-${callIndex++}`,
      }
      const outcome = await rtk.compress(input)
      if (outcome.kind === "compressed") {
        part.state.output = outcome.result.output
        archivedHashes.push(outcome.result.rawHash)
        if (outcome.result.degraded !== null) {
          degradedReason = outcome.result.degraded.reason
        }
      } else if (outcome.degraded !== null) {
        degradedReason = outcome.degraded
      }
    }
  }

  return {
    messages,
    archivedHashes,
    degradedReason,
    latencyMs: performance.now() - started,
  }
}

async function recoverRtkArchives(
  rtk: RtkClient,
  sessionId: string,
  hashes: string[],
): Promise<{ found: number; total: number }> {
  let found = 0
  for (const hash of hashes) {
    try {
      const outcome = await rtk.fetch({ hash, sessionId })
      if (outcome.kind === "found") found++
    } catch {
      // A failed recovery is measured as a miss, not a harness crash.
    }
  }
  return { found, total: hashes.length }
}

interface HeadroomEvidence {
  queryMatches: string[] | null
  archiveRecovery: { found: number; total: number }
}

async function gatherHeadroomEvidence(
  headroom: HeadroomClient,
  sessionId: string,
  result: HeadroomCompressResult | null,
  fixture: FixtureSample,
): Promise<HeadroomEvidence> {
  if (result === null || !result.compacted || result.historyHash === null) {
    return { queryMatches: null, archiveRecovery: { found: 0, total: 0 } }
  }

  const facts = [...fixture.goldenFacts.mustHit, ...fixture.goldenFacts.niceToHave]
  const queryMatches: string[] = []
  for (const fact of facts) {
    try {
      const queryResult = await headroom.retrieve({
        namespace: { projectId: "default", sessionId },
        query: fact,
        limit: 5,
      })
      if ("hits" in queryResult && queryResult.hits.length > 0) queryMatches.push(fact)
    } catch {
      // A failed query remains a query miss.
    }
  }

  const recoveredHashes: string[] = []
  let offset = 0
  let partial = false
  for (let page = 0; page < 10_000; page++) {
    let historyResult: RetrieveByHistoryResult
    try {
      historyResult = await headroom.retrieve({
        namespace: { projectId: "default", sessionId },
        historyHash: result.historyHash,
        offset,
        limit: 50,
      }) as RetrieveByHistoryResult
    } catch {
      partial = true
      break
    }
    if (!historyResult.found) {
      partial = true
      break
    }
    recoveredHashes.push(...historyResult.items.map((item) => item.contentHash))
    partial ||= historyResult.partial
    if (historyResult.nextOffset === null) break
    if (historyResult.nextOffset <= offset) {
      partial = true
      break
    }
    offset = historyResult.nextOffset
  }

  const expectedHashes = result.refs.map((ref) => ref.contentHash)
  let found = 0
  for (let index = 0; index < expectedHashes.length; index++) {
    if (recoveredHashes[index] === expectedHashes[index]) found++
  }
  if (partial && found === expectedHashes.length) found = Math.max(0, found - 1)

  return {
    queryMatches,
    archiveRecovery: { found, total: expectedHashes.length },
  }
}

async function runGroupA(fixtures: FixtureSample[], options: RunnerOptions): Promise<GroupResult> {
  const perFixture: PerFixtureRecord[] = []
  const latencies: LatencySample[] = []
  const recallResults: RecallResult[] = []
  for (const fixture of fixtures) {
    const messages = cloneMessages(fixture.messages)
    const rawText = extractAllText(messages)
    const started = performance.now()
    const outputText = extractAllText(messages)
    const latencyMs = performance.now() - started
    const recall = evaluateRecall(fixture, "A", outputText, null, { found: 0, total: 0 })
    perFixture.push(buildPerFixtureRecord(fixture, "A", rawText, outputText, latencyMs, recall, null))
    latencies.push({ group: "A", fixture: fixture.name, latencyMs })
    recallResults.push(recall)
    observeFinal(options, "A", fixture.name, messages, outputText)
  }
  return { perFixture, latencies, recallResults }
}

async function runGroupB(
  fixtures: FixtureSample[],
  options: RunnerOptions,
  dataDir: string,
): Promise<GroupResult> {
  const rtk = await RtkClient.create(rtkOptions(options, dataDir))
  const perFixture: PerFixtureRecord[] = []
  const latencies: LatencySample[] = []
  const recallResults: RecallResult[] = []
  try {
    for (const fixture of fixtures) {
      const rawText = extractAllText(fixture.messages)
      const sessionId = `eval-${fixture.name}-b`
      const rewritten = await rewriteToolParts(
        rtk,
        cloneMessagesForSession(fixture.messages, sessionId),
        sessionId,
      )
      const outputText = extractAllText(rewritten.messages)
      const archiveRecovery = await recoverRtkArchives(
        rtk,
        sessionId,
        rewritten.archivedHashes,
      )
      const recall = evaluateRecall(fixture, "B", outputText, null, archiveRecovery)
      perFixture.push(
        buildPerFixtureRecord(
          fixture,
          "B",
          rawText,
          outputText,
          rewritten.latencyMs,
          recall,
          rewritten.degradedReason,
        ),
      )
      latencies.push({ group: "B", fixture: fixture.name, latencyMs: rewritten.latencyMs })
      recallResults.push(recall)
      observeFinal(options, "B", fixture.name, rewritten.messages, outputText)
    }
  } finally {
    await rtk.shutdown()
  }
  return { perFixture, latencies, recallResults }
}

function materializeHeadroomResult(
  messages: ChatMessage[],
  result: HeadroomCompressResult,
): { messages: ChatMessage[]; valid: boolean } {
  if (!result.compacted) return { messages, valid: true }
  const materialized = materializeCompaction(messages, result)
  return materialized.status === "applied"
    ? { messages: materialized.messages, valid: true }
    : { messages, valid: false }
}

async function runGroupC(
  fixtures: FixtureSample[],
  options: RunnerOptions,
  dataDir: string,
): Promise<GroupResult> {
  const headroom = await HeadroomClient.connect(headroomOptions(options, dataDir))
  const perFixture: PerFixtureRecord[] = []
  const latencies: LatencySample[] = []
  const recallResults: RecallResult[] = []
  try {
    for (const fixture of fixtures) {
      const rawText = extractAllText(fixture.messages)
      const sessionId = `eval-${fixture.name}-c`
      const sourceMessages = cloneMessagesForSession(fixture.messages, sessionId)
      const params = {
        ...fixturesToHeadroomParams(fixture, options.contextWindowTokens),
        sessionId,
        messages: sourceMessages,
      }
      options.observe?.({
        type: "headroom-input",
        group: "C",
        fixture: fixture.name,
        messages: cloneMessages(sourceMessages),
      })

      let result: HeadroomCompressResult | null = null
      let finalMessages = sourceMessages
      let degradedReason: DegradedReason | null = null
      const started = performance.now()
      try {
        result = await headroom.compress(params)
        const materialized = materializeHeadroomResult(sourceMessages, result)
        finalMessages = materialized.messages
        if (!materialized.valid) degradedReason = "protocol"
      } catch {
        degradedReason = "crash"
      }
      const latencyMs = performance.now() - started
      const outputText = extractAllText(finalMessages)
      const evidence = await gatherHeadroomEvidence(headroom, params.sessionId, result, fixture)
      const recall = evaluateRecall(
        fixture,
        "C",
        outputText,
        evidence.queryMatches,
        evidence.archiveRecovery,
      )
      perFixture.push(
        buildPerFixtureRecord(
          fixture,
          "C",
          rawText,
          outputText,
          latencyMs,
          recall,
          degradedReason,
        ),
      )
      latencies.push({ group: "C", fixture: fixture.name, latencyMs })
      recallResults.push(recall)
      observeFinal(options, "C", fixture.name, finalMessages, outputText)
    }
  } finally {
    await headroom.close()
  }
  return { perFixture, latencies, recallResults }
}

async function runGroupD(
  fixtures: FixtureSample[],
  options: RunnerOptions,
  dataDir: string,
): Promise<GroupResult> {
  const rtk = await RtkClient.create(rtkOptions(options, dataDir))
  const headroom = await HeadroomClient.connect(headroomOptions(options, dataDir))
  const perFixture: PerFixtureRecord[] = []
  const latencies: LatencySample[] = []
  const recallResults: RecallResult[] = []
  try {
    for (const fixture of fixtures) {
      const rawText = extractAllText(fixture.messages)
      const sessionId = `eval-${fixture.name}-d`
      const rewritten = await rewriteToolParts(
        rtk,
        cloneMessagesForSession(fixture.messages, sessionId),
        sessionId,
      )
      const params = {
        ...fixturesToHeadroomParams(fixture, options.contextWindowTokens),
        sessionId,
        messages: rewritten.messages,
      }
      options.observe?.({
        type: "headroom-input",
        group: "D",
        fixture: fixture.name,
        messages: cloneMessages(rewritten.messages),
      })

      let result: HeadroomCompressResult | null = null
      let finalMessages = rewritten.messages
      let degradedReason = rewritten.degradedReason
      const started = performance.now()
      try {
        result = await headroom.compress(params)
        const materialized = materializeHeadroomResult(rewritten.messages, result)
        finalMessages = materialized.messages
        if (!materialized.valid) degradedReason = "protocol"
      } catch {
        degradedReason ??= "crash"
      }
      const headroomLatencyMs = performance.now() - started
      const outputText = extractAllText(finalMessages)
      const [rtkRecovery, headroomEvidence] = await Promise.all([
        recoverRtkArchives(rtk, sessionId, rewritten.archivedHashes),
        gatherHeadroomEvidence(headroom, sessionId, result, fixture),
      ])
      const archiveRecovery = {
        found: rtkRecovery.found + headroomEvidence.archiveRecovery.found,
        total: rtkRecovery.total + headroomEvidence.archiveRecovery.total,
      }
      const recall = evaluateRecall(
        fixture,
        "D",
        outputText,
        headroomEvidence.queryMatches,
        archiveRecovery,
      )
      const latencyMs = rewritten.latencyMs + headroomLatencyMs
      perFixture.push(
        buildPerFixtureRecord(
          fixture,
          "D",
          rawText,
          outputText,
          latencyMs,
          recall,
          degradedReason,
        ),
      )
      latencies.push({ group: "D", fixture: fixture.name, latencyMs })
      recallResults.push(recall)
      observeFinal(options, "D", fixture.name, finalMessages, outputText)
    }
  } finally {
    await rtk.shutdown()
    await headroom.close()
  }
  return { perFixture, latencies, recallResults }
}

async function waitForHeadroomExit(dataDir: string, allowTerminate: boolean): Promise<void> {
  const socketPath = path.join(dataDir, "headroomd.sock")
  for (let attempt = 0; attempt < 60 && existsSync(socketPath); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!existsSync(socketPath)) return

  // An explicit dataDir may point at a pre-existing daemon. Closing our
  // client is sufficient; never signal a process we cannot prove we spawned.
  if (!allowTerminate) return

  // The directory is unique to this run, so this PID can only be our daemon.
  try {
    const pid = Number(await readFile(path.join(dataDir, "headroomd.pid"), "utf8"))
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM")
  } catch {
    // A concurrently exiting daemon may remove the pid file between checks.
  }
  for (let attempt = 0; attempt < 60 && existsSync(socketPath); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (existsSync(socketPath)) throw new Error(`eval headroomd did not exit for ${dataDir}`)
}

export async function runEvaluation(options: RunnerOptions = {}): Promise<RunnerResult> {
  const temporaryDataDir = options.dataDir === undefined
  const dataDir = options.dataDir ?? await mkdtemp(path.join(tmpdir(), "bluecode-eval-"))
  options.observe?.({ type: "data-dir", dataDir, temporary: temporaryDataDir })
  const fixtures = options.quick ? quickFixtures() : allFixtures()

  console.error(`[eval] Running ${fixtures.length} fixtures in ${options.quick ? "quick" : "full"} mode`)
  console.error("[eval] Groups: A (baseline), B (rtk), C (headroomd), D (combined)")

  try {
    console.error("[eval] Group A: baseline (passthrough)...")
    const resultA = await runGroupA(fixtures, options)
    console.error("[eval] Group B: rtk only...")
    const resultB = await runGroupB(fixtures, options, dataDir)
    console.error("[eval] Group C: headroomd only...")
    const resultC = await runGroupC(fixtures, options, dataDir)
    console.error("[eval] Group D: combined (rtk + headroomd)...")
    const resultD = await runGroupD(fixtures, options, dataDir)

    return {
      perFixture: [
        ...resultA.perFixture,
        ...resultB.perFixture,
        ...resultC.perFixture,
        ...resultD.perFixture,
      ],
      latencies: [
        ...resultA.latencies,
        ...resultB.latencies,
        ...resultC.latencies,
        ...resultD.latencies,
      ],
      recallResults: [
        ...resultA.recallResults,
        ...resultB.recallResults,
        ...resultC.recallResults,
        ...resultD.recallResults,
      ],
      dataDir,
      temporaryDataDir,
    }
  } finally {
    await waitForHeadroomExit(dataDir, temporaryDataDir)
    if (temporaryDataDir) {
      await rm(dataDir, { recursive: true, force: true })
    }
  }
}

export function dispose(): void {
  tokenCounter.dispose()
}
