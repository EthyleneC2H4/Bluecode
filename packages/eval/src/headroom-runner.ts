/** Offline observations of the production plugin; never manufactures compression or model answers. */
import { HeadroomClient } from "@bluecode/headroomd"
import { createPluginRuntime, type HeadroomPort, type PluginRuntime } from "@bluecode/plugin/runtime"
import { createRetrieveTool } from "@bluecode/plugin/retrieval"
import { parseOptions } from "@bluecode/plugin/config"
import type { HeadroomCompressResult, LayeredMetrics } from "@bluecode/contracts"
import { estimateTokens } from "@bluecode/shared"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { headroomFixtures, type HeadroomFixture, type HeadroomHostMessage } from "./headroom-fixtures"

export interface HeadroomEvaluationOptions {
  fixtures?: HeadroomFixture[]
  strategies?: Array<"legacy" | "layered">
  replaySteps?: number
  retainRecentTurns?: number
  recoveryCheckpoints?: number[]
  contextWindowTokens?: number
  headroomTimeoutMs?: number
  headroomEntry?: string
  onProgress?: (message: string) => void
}
export interface HeadroomReplayRow {
  strategy: "legacy" | "layered"
  retainRecentTurns?: number
  status: "completed" | "degraded" | "incomplete"
  errors: string[]
  rawSourceTokens: number
  cumulativeInputTokens: number
  retrievalTokens: number
  finalSourceTokens: number
  finalMemoryTokens: number
  finalVisibleTokens: number
  providerUsage: null
  providerCacheReadTokens: null
  providerCacheWriteTokens: null
  summaryCalls: 0
  calls: Array<{ phase: "host" | "query" | "source"; step: number; inputTokens: number; visibleTokens: number; recoveryTokens: number; unchangedPrefixTokens: number }>
  runtime: ReturnType<PluginRuntime["stats"]>
  operations: { compressCalls: number; operationCount: number; scannedMessages: number | null; analyzedMessages: number | null; analysisCacheHits: number | null }
  daemon: { cpuSeconds: number | null; rssPeakBytes: number; queueMs: number | null; serviceMs: number | null; samples: number; forcedTermination: boolean; metrics: LayeredMetrics[] }
  quality: { constraintsFound: number; constraintsTotal: number; protectedMessagesIntact: boolean; sourceRecovered: boolean; naturalEvidenceFound: boolean; naturalProbes?: Array<{ query: string; expected: string[]; found: boolean; firstHit: { hash: string; snippet: string } | null; expandedExcerpt: string }> }
  recoveryCheckpoints: Array<{ step: number; exact: boolean }>
  budgetReasons: string[]
  wallMs: number
}
export interface HeadroomComparison {
  name: string
  scenario: HeadroomFixture["scenario"]
  turns: number
  legacy?: HeadroomReplayRow
  layered: HeadroomReplayRow
  savingsRatio: number | null
  target25PercentMet: boolean | null
}
export interface HeadroomEvaluationResult {
  meta: {
    adapter: string; source: string; tokenCounter: string; providerUsage: string; sampling: string
    cache: string; telemetry: string; sourceRecovery: string; baseline: string; replaySteps: number; contextWindowTokens: number; headroomTimeoutMs: number
  }
  comparisons: HeadroomComparison[]
  additionalComparisons?: HeadroomComparison[]
  diagnosticComparisons?: HeadroomComparison[]
  temporaryDataDir: string
}

/** The counted model boundary is an explicit offline rendering, not provider-specific hidden framing. */
export function renderHeadroomInput(messages: HeadroomHostMessage[]): string {
  return messages.map((m) => `[${m.info.role}]\n` + m.parts.map((p) => {
    if (p.type === "text") return p.text as string
    if (p.type === "tool") return [`[tool:${p.tool}] ${p.state.status}`, ...(p.state.input !== undefined ? [JSON.stringify(p.state.input)] : []), ...(p.state.output ? [p.state.output] : []), ...(p.state.error ? [p.state.error] : [])].join("\n")
    return JSON.stringify(p)
  }).join("\n")).join("\n")
}
function sourceRender(message: HeadroomHostMessage): string { return renderHeadroomInput([message]) }
function cpuSeconds(text: string): number {
  const pieces = text.trim().split(":").map(Number)
  return pieces.reduce((total, value) => total * 60 + value, 0)
}
async function sampleDaemon(pid: number): Promise<{ cpuSeconds: number; rssBytes: number } | null> {
  const process = Bun.spawn(["ps", "-p", String(pid), "-o", "time=", "-o", "rss="], { stdout: "pipe", stderr: "ignore" })
  const output = (await new Response(process.stdout).text()).trim().split(/\s+/)
  if (await process.exited !== 0 || output.length !== 2) return null
  return { cpuSeconds: cpuSeconds(output[0]!), rssBytes: Number(output[1]) * 1024 }
}
async function cleanupDaemon(pid: number | undefined) {
  if (!pid) return false
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  if (alive()) { try { process.kill(pid, "SIGTERM") } catch {} }
  for (let attempt = 0; attempt < 100 && alive(); attempt++) await Bun.sleep(20)
  const forced = alive()
  if (forced) { try { process.kill(pid, "SIGKILL") } catch {} }
  for (let attempt = 0; attempt < 100 && alive(); attempt++) await Bun.sleep(20)
  if (alive()) throw new Error("Owned evaluation daemon did not exit; retaining directory")
  return forced
}

async function replay(fixture: HeadroomFixture, strategy: "legacy" | "layered", directory: string, options: HeadroomEvaluationOptions): Promise<HeadroomReplayRow> {
  let pid: number | undefined, runtime: PluginRuntime | undefined, client: HeadroomClient | undefined
  const started = performance.now(), plans: HeadroomCompressResult[] = [], errors: string[] = []
  const daemon = { cpuSeconds: null as number | null, rssPeakBytes: 0, queueMs: null as number | null, serviceMs: null as number | null, samples: 0, forcedTermination: false, metrics: [] as LayeredMetrics[] }
  const calls: HeadroomReplayRow["calls"] = [], checkpoints: HeadroomReplayRow["recoveryCheckpoints"] = []
  const source = structuredClone(fixture.messages), ns = { projectId: "headroom-dedicated-eval", sessionId: fixture.name }
  const config = parseOptions({ mode: "on", rtk: { mode: "off" }, headroom: { mode: "on", strategy,
    retainRecentTurns: options.retainRecentTurns ?? 4, summarizer: { enabled: false } } })
  let final = source, priorCall = "", cumulativeInputTokens = 0, retrievalTokens = 0, compressCalls = 0
  let originalRef: string | undefined, incomplete = false
  const sample = async () => {
    if (!pid) return
    const measurement = await sampleDaemon(pid)
    if (measurement) { daemon.samples++; daemon.cpuSeconds = measurement.cpuSeconds; daemon.rssPeakBytes = Math.max(daemon.rssPeakBytes, measurement.rssBytes) }
  }
  const count = (messages: HeadroomHostMessage[], phase: "host" | "query" | "source", step: number, recovery = "") => {
    const visible = renderHeadroomInput(messages), input = visible + (recovery ? "\n" + recovery : "")
    let common = 0
    while (common < Math.min(priorCall.length, input.length) && priorCall[common] === input[common]) common++
    const inputTokens = estimateTokens(input)
    calls.push({ phase, step, inputTokens, visibleTokens: estimateTokens(visible), recoveryTokens: estimateTokens(recovery), unchangedPrefixTokens: Math.floor(common / 4) })
    cumulativeInputTokens += inputTokens; priorCall = input
  }
  try {
    client = await HeadroomClient.connect({ dataDir: directory, timeoutMs: options.headroomTimeoutMs ?? 10_000,
      spawn: { entry: options.headroomEntry ?? path.resolve(import.meta.dir, "../../headroomd/src/bin.ts"), cwd: process.cwd(), args: ["--dataDir", directory, "--idleExitMs", "1000"] } })
    pid = Number(await readFile(path.join(directory, "headroomd.pid"), "utf8"))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned daemon PID")
    const real = client
    const port: HeadroomPort = {
      compress: async (params) => {
        compressCalls++
        try {
          const plan = await real.compress(params); plans.push(plan)
          if (plan.metrics) daemon.metrics.push(plan.metrics)
          const index = plan.replacedMessageIds.indexOf(fixture.evidenceMessageId)
          if (!originalRef && index >= 0) originalRef = plan.refs[index]?.contentHash
          await sample()
          return plan
        } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); throw error }
      },
      retrieve: (params) => real.retrieve(params), getView: (params) => real.getView(params),
      setView: (params, plan) => real.setView(params, plan), clearView: (params) => real.clearView(params), close: () => real.close(),
    }
    runtime = createPluginRuntime({ projectId: ns.projectId, directory: process.cwd(), options: config, rtk: null, headroom: port })
    runtime.observeModel(ns.sessionId, { id: "offline-no-model", limit: { context: options.contextWindowTokens ?? 8192, output: 1024 } })
    const retrieve = createRetrieveTool(runtime)
    const context = { sessionID: ns.sessionId, messageID: "eval-probe", agent: "offline-eval", directory: process.cwd(), worktree: process.cwd(), abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
    const fetch = async (args: Parameters<typeof retrieve.execute>[0]) => {
      const result = await retrieve.execute(args, context)
      const text = typeof result === "string" ? result : result.output
      let parsed: any
      try { parsed = JSON.parse(text) } catch { parsed = {} }
      return { text, parsed }
    }
    // Validation-only original-byte probe, excluded from simulated model inputs and counted separately.
    const recover = async () => {
      if (!originalRef) return false
      let cursor: string | undefined, restored = ""
      const seen = new Set<string>()
      for (let page = 0; page < 100; page++) {
        const result = await fetch({ hash: originalRef, maxTokens: 2048, maxBytes: 8192, ...(cursor ? { cursor } : {}) })
        if (typeof result.parsed.content !== "string") return false
        restored += result.parsed.content
        if (!result.parsed.nextCursor) return restored === sourceRender(source.find((m) => m.info.id === fixture.evidenceMessageId)!)
        cursor = result.parsed.nextCursor
        if (!cursor || seen.has(cursor)) return false
        seen.add(cursor)
      }
      return false
    }
    const steps = options.replaySteps ?? 4
    stages: for (let step = 1; step <= steps; step++) {
      const end = step === steps ? source.length : Math.ceil(fixture.turns * step / steps) * 2
      for (let call = 0; call < 2; call++) {
        final = structuredClone(source.slice(0, end))
        await runtime.transform({ messages: final }); count(final, "host", step); await runtime.drain()
        if (errors.some((error) => /timed out|timeout/i.test(error))) { incomplete = true; break stages }
      }
      if (options.recoveryCheckpoints?.includes(step)) checkpoints.push({ step, exact: await recover() })
    }
    let recovery = "", sourceRecovered = false
    const naturalProbes: NonNullable<HeadroomReplayRow["quality"]["naturalProbes"]> = []
    if (!incomplete) {
      const questions = fixture.questions ?? [{ question: `Recover the original observation for ${fixture.query}.`, query: fixture.query, expected: [fixture.evidence] }]
      for (const question of questions) {
        const query = await fetch({ query: question.query, limit: 5, maxTokens: 2048, maxBytes: 8192 })
        retrievalTokens += estimateTokens(query.text)
        recovery += (recovery ? "\n" : "") + `[user]\n${question.question}\n[headroom_retrieve]\n${query.text}`
        count(final, "query", steps, recovery)
        const hit = query.parsed.matches?.[0] ?? query.parsed.hits?.[0] ?? query.parsed.items?.[0]
        const hash = hit?.hash ?? hit?.contentHash
        let expandedExcerpt = ""
        if (typeof hash === "string") {
          const expanded = await fetch({ hash, maxTokens: 2048, maxBytes: 8192 })
          retrievalTokens += estimateTokens(expanded.text)
          recovery += "\n[headroom_retrieve]\n" + expanded.text
          expandedExcerpt = String(expanded.parsed.content ?? expanded.text).slice(0, 512)
          count(final, "source", steps, recovery)
        }
        naturalProbes.push({ query: question.query, expected: question.expected,
          found: question.expected.every((expected) => (renderHeadroomInput(final) + recovery).includes(expected)),
          firstHit: typeof hash === "string" ? { hash, snippet: String(hit.snippet ?? "").slice(0, 512) } : null, expandedExcerpt })
      }
      sourceRecovered = await recover()
    }
    await sample()
    if (daemon.metrics.length) {
      daemon.queueMs = daemon.metrics.reduce((n, m) => n + (m.queueMs ?? 0), 0)
      daemon.serviceMs = daemon.metrics.reduce((n, m) => n + (m.durationMs ?? 0), 0)
    }
    const finalText = renderHeadroomInput(final), visibleSource: string[] = [], memory: string[] = []
    const byId = new Map(source.map((message) => [message.info.id, message]))
    for (const message of final) {
      const old = byId.get(message.info.id)
      for (const [index, part] of message.parts.entries()) {
        const text = part.type === "text" ? String(part.text) : part.type === "tool" ? String(part.state.output ?? "") : JSON.stringify(part)
        if (old && JSON.stringify(old.parts[index]) === JSON.stringify(part)) visibleSource.push(text)
        else memory.push(text)
      }
    }
    const sum = (key: "scannedMessages" | "analyzedMessages" | "analysisCacheHits") => daemon.metrics.length ? daemon.metrics.reduce((n, m) => n + m[key], 0) : null
    const stats = runtime.stats()
    return { strategy, retainRecentTurns: config.headroom.retainRecentTurns, status: incomplete ? "incomplete" : stats.errors || errors.length ? "degraded" : "completed", errors, rawSourceTokens: estimateTokens(renderHeadroomInput(source)),
      cumulativeInputTokens, retrievalTokens, finalSourceTokens: estimateTokens(visibleSource.join("\n")), finalMemoryTokens: estimateTokens(memory.join("\n")), finalVisibleTokens: estimateTokens(finalText),
      providerUsage: null, providerCacheReadTokens: null, providerCacheWriteTokens: null, summaryCalls: 0,
      calls, runtime: stats, operations: { compressCalls, operationCount: plans.reduce((n, p) => n + (p.operations?.length ?? (p.compacted ? 1 : 0)), 0), scannedMessages: sum("scannedMessages"), analyzedMessages: sum("analyzedMessages"), analysisCacheHits: sum("analysisCacheHits") }, daemon,
      quality: { constraintsFound: fixture.constraints.filter((constraint) => finalText.includes(constraint)).length, constraintsTotal: fixture.constraints.length,
        protectedMessagesIntact: fixture.protectedMessageIds.every((id) => JSON.stringify(final.find((m) => m.info.id === id)) === JSON.stringify(byId.get(id))),
        sourceRecovered, naturalEvidenceFound: naturalProbes.length > 0 && naturalProbes.every((probe) => probe.found), naturalProbes }, recoveryCheckpoints: checkpoints,
      budgetReasons: [...new Set(plans.flatMap((p) => p.budget?.reasons ?? []))], wallMs: performance.now() - started }
  } finally {
    await runtime?.dispose()
    if (!runtime) await client?.close()
    daemon.forcedTermination = await cleanupDaemon(pid)
  }
}

export async function runHeadroomEvaluation(options: HeadroomEvaluationOptions = {}): Promise<HeadroomEvaluationResult> {
  const steps = options.replaySteps ?? 4
  if (!Number.isSafeInteger(steps) || steps < 1) throw new Error("replaySteps must be a positive integer")
  const strategies = options.strategies ?? ["legacy", "layered"]
  if (!strategies.includes("layered")) throw new Error("layered comparison is required")
  const directory = await mkdtemp(path.join(tmpdir(), "bluecode-headroom-eval-")), comparisons: HeadroomComparison[] = []
  let cleaned = false
  try {
    for (const fixture of options.fixtures ?? headroomFixtures()) {
      const rows: Partial<Record<"legacy" | "layered", HeadroomReplayRow>> = {}
      for (const strategy of strategies) {
        options.onProgress?.(`${fixture.name}: ${strategy}`)
        rows[strategy] = await replay(fixture, strategy, path.join(directory, `${fixture.name}-${strategy}`), options)
      }
      const legacy = rows.legacy, layered = rows.layered!
      const valid = legacy?.status === "completed" && layered.status === "completed"
      const savings = valid && legacy.cumulativeInputTokens > 0 ? 1 - layered.cumulativeInputTokens / legacy.cumulativeInputTokens : null
      comparisons.push({ name: fixture.name, scenario: fixture.scenario, turns: fixture.turns, ...(legacy ? { legacy } : {}), layered, savingsRatio: savings, target25PercentMet: savings === null ? null : savings >= .25 })
    }
    cleaned = true
    return { meta: { adapter: "@bluecode/plugin/runtime + real spawned headroomd", source: `${options.fixtures?.length ?? 24} deterministic synthetic histories; default 8 scenarios x 50/200/1000 turns; explicit fixture selection may reuse engineering-replay; no external model requests`, tokenCounter: "ceil(UTF-16 characters/4), explicit role/tool/unknown-part rendering; estimates, not tokenizer/provider usage", providerUsage: "No model called; input is replayed model-visible boundary; output and provider cache are unmeasured (null)", sampling: `${steps} equally spaced complete-turn prefixes, two actual transform calls per prefix for both strategies, including pre-plan calls. Query and first-hit source expansion add full-context follow-up inputs. Not a call per historical turn. First compression timeout aborts the remaining calls of that group and marks the row incomplete; incomplete rows never enter savings comparisons.`, cache: "unchangedPrefixTokens is byte-identical-prefix UTF-16/4 opportunity only, not a provider cache hit or discount; analysisCacheHits is daemon reuse", telemetry: "ps time/RSS sampled after compress and final retrieval, CPU includes daemon startup; RSS is sampled peak, not OS high-water mark. Layered queue/service/operation counters from actual RPC; legacy internal counters unavailable=null. Separate fresh daemon per case/group.", sourceRecovery: "Exact original-message hash pagination is validation-only and excluded from model-input totals. 2/5/20 checkpoints are consecutive raw-host planning generations, not recursive tree depth. Final source/memory component estimates omit framing and need not sum to total.", baseline: "62589ac frozen baseline untouched; strategies are compared using current production runtime with identical settings", replaySteps: steps, contextWindowTokens: options.contextWindowTokens ?? 8192, headroomTimeoutMs: options.headroomTimeoutMs ?? 10_000 }, comparisons, temporaryDataDir: directory }
  } finally {
    // Every replay proves its owned PID has exited before this directory is removed.
    if (cleaned) await rm(directory, { recursive: true, force: true })
  }
}
