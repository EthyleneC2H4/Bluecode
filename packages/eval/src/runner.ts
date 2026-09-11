import { collectQueryHits } from "./query-pages"
/** Replay the SAME public plugin adapter as production; sidecars are real processes. */
import { RtkClient } from "@bluecode/rtk"
import { HeadroomClient, type HeadroomClientOptions } from "@bluecode/headroomd"
import { createPluginRuntime, type PluginRuntime } from "@bluecode/plugin/runtime"
import { createRetrieveTool } from "@bluecode/plugin/retrieval"
import { parseOptions } from "@bluecode/plugin/config"
import type { ChatMessage } from "@bluecode/contracts"
import { createExactTokenCounter, sanitize, sha256Hex } from "@bluecode/shared"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { allFixtures, quickFixtures, type FixtureSample } from "./fixtures"
import {
  buildPerFixtureRecord,
  evaluateRecall,
  type EvalGroup,
  type LatencySample,
  type PerFixtureRecord,
  type RecallResult,
} from "./metrics"
import type { ReplayMetrics } from "./replay-metrics"

const tokenCounter = createExactTokenCounter()
const DEFAULT_HEADROOM_ENTRY = path.resolve(import.meta.dir, "../../headroomd/src/bin.ts")
const PROJECT_ID = "eval-real-plugin"
type HostMessage = Parameters<PluginRuntime["transform"]>[0]["messages"][number]
export type EvaluationObservation =
  | { type: "data-dir"; dataDir: string; temporary: boolean }
  | { type: "headroom-input"; group: "C" | "D"; fixture: string; messages: ChatMessage[] }
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
  fixtures?: FixtureSample[]
  replaySteps?: number
  retrievalStrategy?: "query-only" | "eager-recovery"
  headroomStrategy?: "legacy" | "layered"
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
function textOf(messages: HostMessage[]): string {
  return messages
    .flatMap((m) =>
      m.parts.map((p) =>
        p.type === "text" ? p.text : p.type === "tool" ? p.state?.output ?? "" : ""
      )
    )
    .join("\n")
}
/** Independent oracle for the documented history wire rendering; never call the daemon renderer. */
export function expectedHistoryText(message: HostMessage): string {
  return [
    `[${message.info.role}]`,
    ...message.parts.flatMap((p) => {
      if (p.type === "text") return [p.text]
      if (p.type !== "tool") return []
      return [
        `[tool:${p.tool}] ${p.state.status}`,
        ...(p.state.input !== undefined ? [JSON.stringify(p.state.input)] : []),
        ...(p.state.output ? [p.state.output] : []),
        ...(p.state.error ? [p.state.error] : []),
      ]
    }),
  ].join("\n")
}
function headroomOptions(options: RunnerOptions, dataDir: string): HeadroomClientOptions {
  return {
    dataDir,
    timeoutMs: options.headroomTimeoutMs ?? 10_000,
    spawn: {
      entry: options.headroomEntry ?? DEFAULT_HEADROOM_ENTRY,
      cwd: process.cwd(),
      args: ["--dataDir", dataDir, "--idleExitMs", "1000"],
    },
  }
}
function newMetrics(deadlineMs: number): ReplayMetrics {
  return {
    adapter: "@bluecode/plugin/runtime",
    retrievalStrategy: "query-only",
    modelCalls: [],
    totalInputTokens: 0,
    retrievalOutputTokens: 0,
    critical: { found: 0, total: 0 },
    naturalRecallAt5: { found: 0, total: 0, misses: [] },
    tasks: { passed: 0, total: 0, failures: [] },
    violations: { crossNamespace: 0, stalePlan: 0, retrievalRecompression: 0 },
    probes: { crossNamespace: 0, stalePlan: 0, retrievalRecompression: 0 },
    runtime: { rtkCalls: 0, plans: 0, applied: 0, errors: 0 },
    latency: {
      toolHookMs: 0,
      transformMs: 0,
      planningDrainMs: 0,
      retrievalMs: 0,
      archiveProbeMs: 0,
      queueMs: null,
      serviceMs: null,
      deadlineMs,
    },
    rssBytes: process.memoryUsage().rss,
  }
}

async function runFixture(
  group: EvalGroup,
  fixture: FixtureSample,
  options: RunnerOptions,
  dataDir: string,
  daemonPids: Set<number>
) {
  const hasRtk = group === "B" || group === "D",
    hasHeadroom = group === "C" || group === "D"
  const deadlineMs = options.rtkTimeoutMs ?? 40
  const rtk = hasRtk
    ? await RtkClient.create({
        cwd: process.cwd(),
        dataDir,
        testMode: true,
        ...(options.rtkEntry ? { entry: options.rtkEntry } : {}),
        budgetTokens: options.rtkBudgetTokens ?? 512,
        timeoutMs: deadlineMs,
        minBytes: options.rtkMinBytes ?? 512,
      })
    : null
  const headroom = hasHeadroom
    ? await HeadroomClient.connect(headroomOptions(options, dataDir))
    : null
  if (headroom) {
    const pid = Number(await readFile(path.join(dataDir, "headroomd.pid"), "utf8"))
    if (Number.isInteger(pid) && pid > 0) daemonPids.add(pid)
  }
  const config = parseOptions({
    mode: "on",
    dataDir,
    rtk: { mode: hasRtk ? "on" : "off" },
    headroom: { mode: hasHeadroom ? "on" : "off", strategy: options.headroomStrategy ?? "legacy", summarizer: { enabled: false } },
  })
  const runtime = createPluginRuntime({
    projectId: PROJECT_ID,
    directory: process.cwd(),
    options: config,
    rtk,
    headroom,
  })
  const retrieve = createRetrieveTool(runtime)
  const foreignRuntime = createPluginRuntime({
    projectId: `${PROJECT_ID}-foreign`,
    directory: process.cwd(),
    options: config,
    rtk,
    headroom,
  })
  const foreignRetrieve = createRetrieveTool(foreignRuntime)
  const sessionID = `eval-${fixture.name}-${group.toLowerCase()}`
  const source: HostMessage[] = fixture.messages.map((m) => ({
    ...structuredClone(m),
    info: { ...m.info, id: `${sessionID}:${m.info.id}`, sessionID },
  }))
  const rawText = textOf(source)
  const metrics = newMetrics(deadlineMs)
  metrics.retrievalStrategy = options.retrievalStrategy ?? "query-only"
  let finalMessages: HostMessage[] = []
  const archives = new Map<string, string>()
  let degradedReason: PerFixtureRecord["degradedReason"] = null
  const received: string[] = []
  const countCall = (
    messages: HostMessage[],
    phase: "host" | "retrieval",
    retrievalOutput = ""
  ) => {
    // Count this exact offline model-input representation, not an external provider's hidden framing.
    const inputTokens = tokenCounter.count(
      messages.map(expectedHistoryText).join("\n") +
        (received.length ? "\n" + received.join("\n") : "")
    )
    const retrievalTokens = tokenCounter.count(retrievalOutput)
    metrics.modelCalls.push({ phase, inputTokens, retrievalTokens })
    metrics.totalInputTokens += inputTokens
    metrics.retrievalOutputTokens += retrievalTokens
    metrics.rssBytes = Math.max(metrics.rssBytes, process.memoryUsage().rss)
  }
  const context = (session = sessionID) => ({
    sessionID: session,
    messageID: "eval-question",
    agent: "eval",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  })
  const fetchPage = async (
    args: Parameters<typeof retrieve.execute>[0],
    modelVisible = false,
    session = sessionID,
    foreignProject = false
  ): Promise<any> => {
    const started = performance.now()
    const result = await (foreignProject ? foreignRetrieve : retrieve).execute(
      { ...args, maxTokens: 8192, maxBytes: 32768 },
      context(session)
    )
    const output = typeof result === "string" ? result : result.output
    metrics.latency[modelVisible ? "retrievalMs" : "archiveProbeMs"] += performance.now() - started
    if (modelVisible) {
      metrics.probes.retrievalRecompression++
      const before = runtime.stats().rtkCalls
      const hookOutput = typeof result === "string" ? { output } : structuredClone(result)
      await runtime.toolAfter(
        { tool: "headroom_retrieve", sessionID, callID: `retrieve-${received.length}`, args },
        hookOutput
      )
      if (hookOutput.output !== output || runtime.stats().rtkCalls !== before)
        metrics.violations.retrievalRecompression++
      received.push(output)
      countCall(finalMessages, "retrieval", output)
    }
    try {
      return JSON.parse(output)
    } catch {
      return { unavailable: output }
    }
  }
  const fetchAll = async (hash: string, modelVisible = false) => {
    let cursor: string | undefined,
      content = ""
    const seen = new Set<string>()
    for (let page = 0; page < 10_000; page++) {
      const result = await fetchPage({ hash, ...(cursor ? { cursor } : {}) }, modelVisible)
      if (!(result.found === true || result.kind === "found") || typeof result.content !== "string")
        return null
      content += result.content
      if (!result.nextCursor) return content
      if (seen.has(result.nextCursor)) return null
      seen.add(result.nextCursor)
      cursor = result.nextCursor
    }
    return null
  }
  try {
    runtime.observeModel(sessionID, {
      providerID: "offline-eval",
      id: "deterministic-replay",
      limit: { context: options.contextWindowTokens ?? 8192, output: 1024 },
    })
    let processed = 0
    const steps = options.replaySteps ?? 4
    for (let step = 1; step <= steps; step++) {
      const end = Math.ceil((source.length * step) / steps)
      for (; processed < end; processed++) {
        for (const [index, part] of source[processed]!.parts.entries()) {
          if (part.type !== "tool" || typeof part.state.output !== "string") continue
          const original = part.state.output as string
          if (hasRtk && Buffer.byteLength(original) >= (options.rtkMinBytes ?? 512))
            archives.set(`sha256:${await sha256Hex(sanitize(original))}`, sanitize(original))
          const output: { output: string; metadata?: any } = { output: original }
          const started = performance.now()
          await runtime.toolAfter(
            { tool: part.tool, sessionID, callID: `${processed}-${index}`, args: {} },
            output
          )
          metrics.latency.toolHookMs += performance.now() - started
          part.state.output = output.output
          const reason = output.metadata?.bluecode?.degraded
          if (
            reason &&
            ["spawn_failed", "timeout", "crash", "protocol", "no_gain"].includes(
              typeof reason === "string" ? reason : reason.reason
            )
          )
            degradedReason = typeof reason === "string" ? reason : reason.reason
        }
      }
      if (hasHeadroom)
        options.observe?.({
          type: "headroom-input",
          group: group as "C" | "D",
          fixture: fixture.name,
          messages: structuredClone(source.slice(0, end)) as ChatMessage[],
        })
      // Two actual host calls per fixed stage: the first schedules, the second applies the ready view.
      // Both are counted for every group, including passthrough A.
      for (let call = 0; call < 2; call++) {
        const fresh = structuredClone(source.slice(0, end))
        let started = performance.now()
        await runtime.transform({ messages: fresh })
        metrics.latency.transformMs += performance.now() - started
        countCall(fresh, "host")
        finalMessages = fresh
        started = performance.now()
        await runtime.drain()
        metrics.latency.planningDrainMs += performance.now() - started
      }
    }
    const finalText = textOf(finalMessages)
    metrics.critical = {
      total: fixture.criticalFacts?.length ?? 0,
      found: (fixture.criticalFacts ?? []).filter((f) => finalText.includes(f)).length,
    }
    const archiveRecovery = { found: 0, total: 0 }
    for (const [hash, expected] of archives) {
      archiveRecovery.total++
      if ((await fetchAll(hash)) === expected) archiveRecovery.found++
      metrics.probes.crossNamespace++
      const foreign = await fetchPage({ hash }, false, `${sessionID}-foreign`)
      if (foreign.kind === "found" || foreign.found === true) metrics.violations.crossNamespace++
      metrics.probes.crossNamespace++
      const foreignProject = await fetchPage({ hash }, false, sessionID, true)
      if (foreignProject.kind === "found" || foreignProject.found === true)
        metrics.violations.crossNamespace++
    }
    const plan = await headroom?.getView({ projectId: PROJECT_ID, sessionId: sessionID })
    if (hasHeadroom) metrics.headroom = {
      strategy: config.headroom.strategy,
      activeViewStrategy: plan ? plan.strategy ?? "legacy" : null,
      memoryMaxTokens: config.headroom.memoryMaxTokens,
      memoryRatio: config.headroom.memoryRatio,
      summarizerEnabled: config.headroom.summarizer.enabled,
    }
    if (plan?.compacted && plan.historyHash) {
      const recovered: Array<{ hash: string; content: string }> = []
      let cursor: string | undefined,
        valid = true
      const seen = new Set<string>()
      for (let page = 0; page < 10_000; page++) {
        const result = await fetchPage({
          historyHash: plan.historyHash,
          ...(cursor ? { cursor } : {}),
        })
        if (!result.found || result.partial || !Array.isArray(result.items)) {
          valid = false
          break
        }
        for (const item of result.items) {
          const last = recovered.at(-1)
          if (last && last.hash === item.contentHash) last.content += item.content
          else recovered.push({ hash: item.contentHash, content: item.content })
        }
        if (!result.nextCursor) break
        if (seen.has(result.nextCursor)) {
          valid = false
          break
        }
        seen.add(result.nextCursor)
        cursor = result.nextCursor
      }
      for (const [index, id] of plan.replacedMessageIds.entries()) {
        archiveRecovery.total++
        const original = source.find((m) => m.info.id === id)
        if (
          valid &&
          original &&
          recovered[index]?.hash === plan.refs[index]?.contentHash &&
          recovered[index]?.content === expectedHistoryText(original)
        )
          archiveRecovery.found++
      }
      metrics.probes.crossNamespace++
      const foreign = await fetchPage(
        { historyHash: plan.historyHash },
        false,
        `${sessionID}-foreign`
      )
      if (foreign.found === true) metrics.violations.crossNamespace++
      metrics.probes.crossNamespace++
      if (
        (await fetchPage({ historyHash: plan.historyHash }, false, sessionID, true)).found === true
      )
        metrics.violations.crossNamespace++
    }
    // Natural search is scored on independent expected identifiers within the top five returned documents.
    // No golden answer is passed as the query. Archive validation above is never credited as task evidence.
    const queryMatches: string[] = []
    for (const question of fixture.questions ?? []) {
      received.push(`[user]\n${question.question}`)
      countCall(finalMessages, "host")
      let evidence = "",
        found = false
      if (hasHeadroom && plan?.compacted) {
        metrics.naturalRecallAt5.total++
        const hits = await collectQueryHits((cursor) =>
          fetchPage({ query: question.query, limit: 5, ...(cursor ? { cursor } : {}) }, true)
        )
        evidence = hits.map((hit) => hit.snippet).join("\n")
        if (metrics.retrievalStrategy === "eager-recovery") {
          for (const hash of new Set(hits.map((hit) => hit.hash)))
            evidence += "\n" + ((await fetchAll(hash, true)) ?? "")
        }
        found = question.expected.every((answer) => evidence.includes(answer))
        if (found) {
          metrics.naturalRecallAt5.found++
          queryMatches.push(...question.expected)
        } else metrics.naturalRecallAt5.misses.push(question.question)
      }
      metrics.tasks.total++
      if (question.expected.every((answer) => (finalText + evidence).includes(answer)))
        metrics.tasks.passed++
      else metrics.tasks.failures.push(question.question)
    }
    // Validation-only probe: a late plan for the old bytes may never replace edited source.
    if (plan?.compacted && source[0]) {
      metrics.probes.stalePlan++
      const edited = structuredClone(source)
      const text = edited[0]!.parts.find((p) => p.type === "text")
      if (text) text.text += "\nEDITED_SOURCE_SENTINEL"
      else edited[0]!.parts.push({ type: "text", text: "EDITED_SOURCE_SENTINEL" })
      await runtime.transform({ messages: edited })
      if (
        edited[0]?.info.id !== source[0]!.info.id ||
        !textOf(edited).includes("EDITED_SOURCE_SENTINEL")
      )
        metrics.violations.stalePlan++
      await runtime.drain()
    }
    metrics.runtime = runtime.stats()
    const recall = evaluateRecall(
      fixture,
      group,
      finalText,
      hasHeadroom && plan?.compacted && fixture.questions?.length ? queryMatches : null,
      archiveRecovery
    )
    const latencyMs =
      metrics.latency.toolHookMs + metrics.latency.transformMs + metrics.latency.planningDrainMs
    const row = buildPerFixtureRecord(
      fixture,
      group,
      rawText,
      finalText,
      latencyMs,
      recall,
      degradedReason
    )
    row.replay = metrics
    options.observe?.({
      type: "final-context",
      group,
      fixture: fixture.name,
      messages: structuredClone(finalMessages) as ChatMessage[],
      text: finalText,
      outTokens: row.outTokens,
    })
    return { row, recall, latency: { group, fixture: fixture.name, latencyMs } }
  } finally {
    await runtime.dispose()
    await foreignRuntime.dispose()
  }
}
async function waitForHeadroomExit(
  dataDir: string,
  allowTerminate: boolean,
  daemonPids: Set<number>
): Promise<void> {
  if (allowTerminate) {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    // Only signal PIDs observed in this run’s unique temporary directory. Socket unlink is not process exit.
    for (const pid of daemonPids)
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGTERM")
        } catch {}
      }
    for (let attempt = 0; attempt < 100 && [...daemonPids].some(alive); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if ([...daemonPids].some(alive))
      throw new Error("eval daemon did not exit before temporary-directory cleanup")
    return
  }
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
  const dataDir = options.dataDir ?? (await mkdtemp(path.join(tmpdir(), "bluecode-eval-")))
  options.observe?.({ type: "data-dir", dataDir, temporary: temporaryDataDir })
  const fixtures = options.fixtures ?? (options.quick ? quickFixtures() : allFixtures())
  const daemonPids = new Set<number>()
  const result: RunnerResult = {
    perFixture: [],
    latencies: [],
    recallResults: [],
    dataDir,
    temporaryDataDir,
  }
  try {
    for (const group of ["A", "B", "C", "D"] as const) {
      console.error(`[eval] Group ${group}: ${fixtures.length} real plugin replays`)
      for (const fixture of fixtures) {
        const row = await runFixture(group, fixture, options, dataDir, daemonPids)
        result.perFixture.push(row.row)
        result.recallResults.push(row.recall)
        result.latencies.push(row.latency)
      }
    }
    return result
  } finally {
    await waitForHeadroomExit(dataDir, temporaryDataDir, daemonPids)
    if (temporaryDataDir) await rm(dataDir, { recursive: true, force: true })
  }
}
export function dispose(): void {
  tokenCounter.dispose()
}

export interface ConcurrencySample {
  headroomStrategy?: "legacy" | "layered"
  concurrency: number
  completed: number
  rtkCalls: number
  headroomPlans: number
  overloaded: number
  errors: number
  degradedCalls: number
  elapsedMs: number
  hookP50Ms: number
  hookP95Ms: number
  planningDrainMs: number
  deadlineMs: number
  queueMs: null
  serviceMs: null
  rssBytes: number
}
/** Shared real clients and one production runtime; queue overload is evidence, never hidden. */
export async function runConcurrencyBenchmarks(headroomStrategy: "legacy" | "layered" = "legacy"): Promise<ConcurrencySample[]> {
  const samples: ConcurrencySample[] = []
  for (const concurrency of [1, 8, 32]) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bluecode-eval-bench-"))
    const daemonPids = new Set<number>()
    const rtk = await RtkClient.create({
      cwd: process.cwd(),
      dataDir,
      testMode: true,
      timeoutMs: 40,
    })
    const headroom = await HeadroomClient.connect(headroomOptions({}, dataDir))
    daemonPids.add(Number(await readFile(path.join(dataDir, "headroomd.pid"), "utf8")))
    const runtime = createPluginRuntime({
      projectId: "benchmark",
      directory: process.cwd(),
      options: parseOptions({ headroom: { strategy: headroomStrategy, summarizer: { enabled: false } } }),
      rtk,
      headroom,
    })
    try {
      const fixture = allFixtures().find((f) => f.name === "engineering-replay")!
      const ls = allFixtures().find((f) => f.name === "tool-ls-large")!.messages[0]!.parts[0]!
      if (ls.type !== "tool") throw new Error("invalid benchmark fixture")
      let completed = 0,
        degradedCalls = 0
      const hooks: number[] = [],
        started = performance.now()
      await Promise.all(
        Array.from({ length: concurrency }, async (_, i) => {
          const sessionID = `concurrent-${i}`
          runtime.observeModel(sessionID, { id: "offline", limit: { context: 8192, output: 1024 } })
          const output: { output: string; metadata?: any } = { output: ls.state.output! }
          const hookStart = performance.now()
          await runtime.toolAfter({ tool: "ls", sessionID, callID: `call-${i}`, args: {} }, output)
          hooks.push(performance.now() - hookStart)
          if (output.metadata?.bluecode?.degraded) degradedCalls++
          const messages = fixture.messages.map((m) => ({
            ...structuredClone(m),
            info: { ...m.info, id: `${sessionID}:${m.info.id}`, sessionID },
          }))
          await runtime.transform({ messages })
          completed++
        })
      )
      const drainStarted = performance.now()
      await runtime.drain()
      const stats = runtime.stats()
      hooks.sort((a, b) => a - b)
      samples.push({
        headroomStrategy,
        concurrency,
        completed,
        rtkCalls: stats.rtkCalls,
        headroomPlans: stats.plans,
        overloaded: stats.overloaded,
        errors: stats.errors,
        degradedCalls,
        elapsedMs: performance.now() - started,
        hookP50Ms: hooks[Math.ceil(hooks.length * 0.5) - 1]!,
        hookP95Ms: hooks[Math.ceil(hooks.length * 0.95) - 1]!,
        planningDrainMs: performance.now() - drainStarted,
        deadlineMs: 40,
        queueMs: null,
        serviceMs: null,
        rssBytes: process.memoryUsage().rss,
      })
    } finally {
      await runtime.dispose()
      await waitForHeadroomExit(dataDir, true, daemonPids)
      await rm(dataDir, { recursive: true, force: true })
    }
  }
  return samples
}
