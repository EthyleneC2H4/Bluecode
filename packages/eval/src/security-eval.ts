/** Offline quality accounting and explicitly opt-in, fixed-machine performance. */
import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { mkdtemp, rm } from "node:fs/promises"
import { cpus, hostname, platform, release, tmpdir, totalmem } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SecurityDecision, SecurityEvaluateParams } from "@bluecode/contracts"
import { VsecClient } from "@bluecode/vsecagent/client"
import { createPluginRuntime } from "@bluecode/plugin/runtime"
import { parseOptions } from "@bluecode/plugin/config"
import { createExactTokenCounter } from "@bluecode/shared"
import { acceptanceFixtures, developmentFixtures, categories, fixturePolicy, type SecurityFixture } from "./security-fixtures"

export interface SecurityObservation {
  fixture: SecurityFixture
  elapsedMs: number
  result?: SecurityDecision & { queueMs?: number; serviceMs?: number }
  error?: string
}
const safeReason = (error: unknown) => {
  const reason = typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined
  return typeof reason === "string" && ["startup", "timeout", "crash", "protocol", "overloaded", "input", "closed", "service"].includes(reason) ? reason : "error"
}
export async function runSecurityFixtures(fixtures: SecurityFixture[], evaluate: (params: SecurityEvaluateParams) => Promise<SecurityDecision>): Promise<SecurityObservation[]> {
  const result: SecurityObservation[] = []
  for (const fixture of fixtures) {
    const started = performance.now()
    try { result.push({ fixture, result: await evaluate(structuredClone(fixture.params)), elapsedMs: performance.now() - started }) }
    catch (error) { result.push({ fixture, error: safeReason(error), elapsedMs: performance.now() - started }) }
  }
  return result
}
function counts(observations: SecurityObservation[]) {
  const count = (predicate: (o: SecurityObservation) => boolean) => observations.filter(predicate).length
  const detected = (o: SecurityObservation) => !!o.result?.findings.some(f => f.category === o.fixture.category)
  const risk = (o: SecurityObservation) => o.fixture.label === "risk"
  return {
    total: observations.length, risk: count(risk), benign: count(o => !risk(o)),
    detected: count(detected), riskDetected: count(o => risk(o) && detected(o)),
    warned: count(o => o.result?.decision === "warn"), denied: count(o => o.result?.decision === "deny"),
    uncovered: count(o => !o.result || o.result.coverage !== "complete"), unavailable: count(o => !o.result || o.result.decision === "unavailable"),
    supportedRisk: count(o => risk(o) && o.fixture.supportedScope === "supported"),
    supportedRiskDetected: count(o => risk(o) && o.fixture.supportedScope === "supported" && detected(o)),
    criticalExpected: count(o => o.fixture.expectedHighConfidenceCritical),
    criticalBlocked: count(o => o.fixture.expectedHighConfidenceCritical && o.result?.decision === "deny"),
    falseBlocks: count(o => !risk(o) && o.result?.decision === "deny"), falseWarnings: count(o => !risk(o) && o.result?.decision === "warn"),
  }
}
export function summarizeSecurity(observations: SecurityObservation[]) {
  const total = counts(observations)
  const rates = {
    supportedRiskRecall: total.supportedRisk ? total.supportedRiskDetected / total.supportedRisk : 0,
    criticalBlocking: total.criticalExpected ? total.criticalBlocked / total.criticalExpected : 0,
    benignFalseBlockRate: total.benign ? total.falseBlocks / total.benign : 0,
    benignFalseWarningRate: total.benign ? total.falseWarnings / total.benign : 0,
  }
  const gates = {
    supportedRiskRecall: total.supportedRisk > 0 && rates.supportedRiskRecall >= 0.95,
    criticalBlocking: total.criticalExpected > 0 && rates.criticalBlocking === 1,
    benignFalseBlocks: total.benign > 0 && total.falseBlocks === 0,
    benignFalseWarnings: total.benign > 0 && rates.benignFalseWarningRate <= 0.05,
    transportComplete: observations.length > 0 && total.unavailable === 0,
  }
  return { total, perCategory: Object.fromEntries(categories.map(category => [category, counts(observations.filter(o => o.fixture.category === category))])), rates, gates, passed: Object.values(gates).every(Boolean) }
}
export function latencySummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null
  return { count: sorted.length, p50Ms: rank(0.5), p95Ms: rank(0.95), maxMs: sorted.at(-1) ?? null }
}
export interface TextAccountingInput {
  before: string; after: string; constraints: string[]; secret: string; redactions: number; withheld: boolean; beforeTokens: number; afterTokens: number
}
export function accountSecurityText(rows: TextAccountingInput[]) {
  const sum = (fn: (row: TextAccountingInput) => number) => rows.reduce((n, row) => n + fn(row), 0)
  const rawTokens = sum(row => row.beforeTokens), modelVisibleTokens = sum(row => row.afterTokens)
  return {
    total: rows.length, constraintsTotal: sum(row => row.constraints.length), constraintsRetained: sum(row => row.constraints.filter(c => row.after.includes(c)).length),
    secretLeaks: sum(row => Number(row.after.includes(row.secret))), redactions: sum(row => row.redactions), withheldFields: sum(row => Number(row.withheld)),
    rawTokens, modelVisibleTokens, securityTokenDelta: modelVisibleTokens - rawTokens,
    compressionSavingsTokens: 0, withheldInputTokens: sum(row => row.withheld ? row.beforeTokens : 0),
  }
}
export function serializeObservation(o: SecurityObservation) {
  const { params: _params, ...labels } = o.fixture
  return { ...labels, elapsedMs: o.elapsedMs,
    ...(o.error ? { error: o.error } : {}),
    ...(o.result ? { decision: o.result.decision, coverage: o.result.coverage, ruleIds: o.result.findings.map(f => f.ruleId), findingCategories: [...new Set(o.result.findings.map(f => f.category))], diagnostics: o.result.diagnostics, queueMs: o.result.queueMs, serviceMs: o.result.serviceMs } : {}),
  }
}
export async function runSecurityQuality() {
  const directory = await mkdtemp(join(tmpdir(), "bluecode-vsec-quality-"))
  let client: VsecClient | undefined
  try {
    const started = performance.now()
    client = await VsecClient.create({ dataDir: directory })
    const coldStartupMs = performance.now() - started
    const development = await runSecurityFixtures(developmentFixtures, params => client!.evaluateTool(params))
    const acceptance = await runSecurityFixtures(acceptanceFixtures, params => client!.evaluateTool(params))
    return { coldStartupMs, development160: summarizeSecurity(development), acceptance320: summarizeSecurity(acceptance),
      observations: [...development, ...acceptance].map(serializeObservation), health: await client.health() }
  } finally { await client?.shutdown(); await rm(directory, { recursive: true, force: true }) }
}
export async function runSecurityTextGroup() {
  const directory = await mkdtemp(join(tmpdir(), "bluecode-vsec-text-"))
  const counter = createExactTokenCounter()
  let client: VsecClient | undefined
  const rows: TextAccountingInput[] = []
  try {
    client = await VsecClient.create({ dataDir: directory })
    const secret = "ghp_Z7xC6vB5nM4aS3dF2gH1jK0lQ9wE8rT7yU6I"
    const surfaces = ["user-message", "system", "tool-output", "retrieval"] as const
    for (const surface of surfaces) {
      const runtime = createPluginRuntime({ projectId: "text-quality", directory, options: parseOptions({ mode: "off", security: { mode: "enforce" } }), rtk: null, headroom: null,
        security: { evaluateTool: p => client!.evaluateTool(p), sanitize: p => client!.sanitize(p), shutdown: async () => {} } })
      const before = `Keep retries=4.\nTLS=required.\nAuthorization: Bearer ${secret}\nPreserve API compatibility.`
      let after = ""
      if (surface === "user-message") {
        const output = { messages: [{ info: { id: "u", role: "user", sessionID: "text" }, parts: [{ type: "text", text: before }] }] }
        await runtime.transform(output); after = output.messages[0]!.parts[0]!.text
      } else if (surface === "system") {
        const output = { system: [before] }; await runtime.systemTransform("text", output); after = output.system[0]!
      } else if (surface === "tool-output") {
        const output = { output: before, metadata: {} }; await runtime.toolAfter({ tool: "read", sessionID: "text", callID: "text", args: {} }, output); after = output.output
      } else { after = (await runtime.sanitizeRetrieval("text", { content: before, nextCursor: "cursor" })).content }
      rows.push({ before, after, secret, constraints: ["retries=4", "TLS=required", "Preserve API compatibility"], redactions: runtime.securityStats().redactions, withheld: after.includes("content withheld"), beforeTokens: counter.count(before), afterTokens: counter.count(after) })
      await runtime.dispose()
    }
    const healthy = accountSecurityText(rows)
    const failing = createPluginRuntime({ projectId: "text-failure", directory, options: parseOptions({ mode: "off", security: { mode: "enforce" } }), rtk: null, headroom: null, security: null })
    const before = `Keep retries=4. ${secret}`
    const output = { system: [before] }
    await failing.systemTransform("text", output)
    const after = output.system[0]!
    const degraded = accountSecurityText([{ before, after, secret, constraints: ["retries=4"], redactions: 0, withheld: after.includes("content withheld"), beforeTokens: counter.count(before), afterTokens: counter.count(after) }])
    await failing.dispose()
    return { tokenCounter: "o200k_base", compressionMode: "off", healthy: { ...healthy, passed: healthy.secretLeaks === 0 && healthy.constraintsRetained === healthy.constraintsTotal && healthy.withheldFields === 0 }, unavailable: { ...degraded, passed: degraded.secretLeaks === 0 && degraded.withheldFields === 1 }, notes: "Real plugin runtime and real child for healthy paths; absent scanner for fail-closed. Redaction and withheld text are never compression savings. This group does not measure answer quality or paid model cost." }
  } finally { await client?.shutdown(); await rm(directory, { recursive: true, force: true }) }
}
export async function securityEnvironment(command: string[]) {
  const fixtureSource = await Bun.file(new URL("./security-fixtures.ts", import.meta.url)).text()
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" })
    return (await new Response(child.stdout).text()).trim()
  }
  const repository = fileURLToPath(new URL("../../../", import.meta.url))
  const productionPaths = ["packages/contracts/src/security.ts", "packages/plugin/src/runtime.ts", "packages/plugin/src/config.ts", "packages/plugin/src/security.ts", "packages/plugin/src/security-tools.ts", ...["index", "typescript", "credentials", "bash", "bounds", "paths", "sanitize"].map(name => `packages/security-core/src/${name}.ts`), ...["client", "protocol", "engine", "cache", "bin", "audit"].map(name => `packages/vsecagent/src/${name}.ts`)]
  const sourceDigests = Object.fromEntries(await Promise.all(productionPaths.map(async path => [path, createHash("sha256").update(Buffer.from(await Bun.file(join(repository, path)).arrayBuffer())).digest("hex")])) )
  const coreDirectory = dirname(fileURLToPath(new URL("../../security-core/src/index.ts", import.meta.url)))
  const packageVersion = async (name: string) => (await Bun.file(Bun.resolveSync(`${name}/package.json`, coreDirectory)).json() as { version: string }).version
  return { timestamp: new Date().toISOString(), command, host: hostname(), platform: platform(), release: release(), arch: process.arch, bun: Bun.version, node: process.version,
    cpu: cpus()[0]?.model ?? "unavailable", logicalCpus: cpus().length, memoryBytes: totalmem(),
    gitCommit: await git(["rev-parse", "HEAD"]), gitDirty: (await git(["status", "--porcelain"])).length > 0, sourceDigests,
    fixtureFreezeCommit: "5e50e82", fixtureSha256: createHash("sha256").update(fixtureSource).digest("hex"),
    parser: { typescript: await packageVersion("typescript"), webTreeSitter: await packageVersion("web-tree-sitter"), bashGrammar: await packageVersion("tree-sitter-bash") }, policy: fixturePolicy,
    config: { deadlineMs: 1000, maxPending: 32, maxQueueBytes: 8 * 1024 ** 2, maxFieldBytes: 1024 ** 2, cacheBytes: 16 * 1024 ** 2 },
    fixtureCounts: { development160: developmentFixtures.length, acceptance320: acceptanceFixtures.length },
  }
}

type Workload = "simple-command" | "simple-path" | "typescript64KiB" | "typescript1MiB"
interface TimedCall { elapsedMs: number; queueMs?: number; serviceMs?: number; error?: string }
const timingContext = new AsyncLocalStorage<{ queueMs?: number; serviceMs?: number; error?: string }>()
function sourceFixture(bytes: number, sequence: number): string {
  const header = `// unique request ${sequence}\n`
  const lines: string[] = []
  let size = header.length
  for (let n = 0; ; n++) {
    const line = `export const item${n} = { retry: 4, path: "/v1/items/${n}", enabled: true };\n`
    if (size + line.length + 5 > bytes) break
    lines.push(line); size += line.length
  }
  return header + lines.join("") + "//" + " ".repeat(bytes - size - 2)
}
function performanceInput(workload: Workload, directory: string, sequence: number): { params: SecurityEvaluateParams; args: Record<string, unknown> } {
  const common = { namespace: { projectId: "perf", sessionId: "warm" }, cwd: directory, root: directory, policy: structuredClone(fixturePolicy), files: [], paths: [], args: {} }
  if (workload === "simple-command") {
    const args = { command: `git status --short # request ${sequence}` }
    return { params: { ...common, tool: "bash", args }, args }
  }
  if (workload === "simple-path") {
    const filePath = join(directory, `report-${sequence}.txt`), args = { filePath }
    return { params: { ...common, tool: "read", args, paths: [{ path: filePath, resolvedPath: filePath, operation: "read" }] }, args }
  }
  const content = sourceFixture(workload === "typescript64KiB" ? 64 * 1024 : 1024 ** 2, sequence)
  const filePath = join(directory, "fixture.ts"), args = { filePath, content }
  return { params: { ...common, tool: "write", args, files: [{ path: filePath, content, complete: true }], paths: [{ path: filePath, resolvedPath: filePath, operation: "write" }] }, args }
}
async function childCpu(pid: number) {
  try {
    const child = Bun.spawn(["ps", "-p", String(pid), "-o", "time="], { stdout: "pipe", stderr: "ignore" })
    const value = (await new Response(child.stdout).text()).trim()
    return value || null
  } catch { return null }
}
export async function runSecurityPerformance(samples = 32) {
  if (!Number.isInteger(samples) || samples < 20) throw new Error("Performance requires at least 20 samples per group")
  const directory = await mkdtemp(join(tmpdir(), "bluecode-vsec-perf-"))
  const groups = []
  const coldStarts = []
  const overallCpu = process.cpuUsage(), wallStarted = performance.now()
  let sequence = 0
  try {
    for (const workload of ["simple-command", "simple-path", "typescript64KiB", "typescript1MiB"] as const) {
      for (const boundary of ["scanner-request", "full-toolBefore-hook"] as const) {
        const startup = performance.now()
        const client = await VsecClient.create({ dataDir: directory })
        const started = await client.health()
        coldStarts.push({ workload, boundary, startupMs: performance.now() - startup, childRssBytes: started.rssBytes })
        let evaluationRequests = 0, sanitizationRequests = 0
        const runtime = createPluginRuntime({ projectId: "perf", directory, options: parseOptions({ mode: "off", security: { mode: "enforce" } }), rtk: null, headroom: null,
          security: { evaluateTool: async p => {
            evaluationRequests++
            const timing = timingContext.getStore()
            try { const result = await client.evaluateTool(p); if (timing) { timing.queueMs = result.queueMs; timing.serviceMs = result.serviceMs }; return result }
            catch (error) { if (timing) timing.error = safeReason(error); throw error }
          }, sanitize: p => { sanitizationRequests++; return client.sanitize(p) }, shutdown: async () => {} } })
        const call = async (input: ReturnType<typeof performanceInput>): Promise<TimedCall> => {
          const timing: { queueMs?: number; serviceMs?: number; error?: string } = {}
          const entered = performance.now()
          try {
            if (boundary === "scanner-request") { evaluationRequests++; const response = await client.evaluateTool(input.params); timing.queueMs = response.queueMs; timing.serviceMs = response.serviceMs }
            else await timingContext.run(timing, () => runtime.toolBefore({ tool: input.params.tool, sessionID: "warm", callID: crypto.randomUUID() }, { args: input.args }))
          } catch (error) { timing.error ??= safeReason(error) }
          return { ...timing, elapsedMs: performance.now() - entered }
        }
        try {
          for (const cacheMode of ["miss", "hit"] as const) {
            for (const concurrency of [1, 8, 32]) {
              const stable = performanceInput(workload, directory, ++sequence)
              const first = await call(stable)
              const healthBefore = await client.health()
              const evaluationRequestsBefore = evaluationRequests, sanitizationRequestsBefore = sanitizationRequests
              const cpuBefore = process.cpuUsage(), cpuChildBefore = await childCpu(healthBefore.pid)
              const values: TimedCall[] = []
              const inputs = Array.from({ length: Math.ceil(samples / concurrency) * concurrency }, () => cacheMode === "hit" ? stable : performanceInput(workload, directory, ++sequence))
              const rssBefore = process.memoryUsage().rss, wall = performance.now()
              let sampledPeakParentRssBytes = rssBefore
              const sampler = setInterval(() => { sampledPeakParentRssBytes = Math.max(sampledPeakParentRssBytes, process.memoryUsage().rss) }, 5)
              try {
                for (let n = 0; n < inputs.length; n += concurrency) values.push(...await Promise.all(inputs.slice(n, n + concurrency).map(call)))
              } finally { clearInterval(sampler) }
              const durationMs = performance.now() - wall
              const healthAfter = await client.health(), cpuUsage = process.cpuUsage(cpuBefore)
              const success = values.filter(value => !value.error)
              const failures = Object.fromEntries([...new Set(values.filter(v => v.error).map(v => v.error!))].map(reason => [reason, values.filter(v => v.error === reason).length]))
              const targetMs = workload.startsWith("simple") ? 30 : workload === "typescript64KiB" ? 150 : 500
              const turnaround = latencySummary(success.map(v => v.elapsedMs))
              groups.push({ workload, boundary, cacheMode, concurrency, requests: values.length, successful: success.length, failures,
                timeoutRate: (failures.timeout ?? 0) / values.length, overloadRate: (failures.overloaded ?? 0) / values.length,
                latencySuccessful: turnaround, latencyAllSettled: latencySummary(values.map(v => v.elapsedMs)),
                queue: latencySummary(success.flatMap(v => v.queueMs === undefined ? [] : [v.queueMs])), childService: latencySummary(success.flatMap(v => v.serviceMs === undefined ? [] : [v.serviceMs])),
                cacheHits: healthAfter.pid === healthBefore.pid ? healthAfter.cacheHits - healthBefore.cacheHits : null,
                cacheHitScope: "all child operations, including diagnostic sanitization after blocked hooks",
                evaluationRequests: evaluationRequests - evaluationRequestsBefore, sanitizationRequests: sanitizationRequests - sanitizationRequestsBefore,
                childRestarted: healthAfter.pid !== healthBefore.pid, cacheBytes: healthAfter.cacheBytes,
                parentRssBeforeBytes: rssBefore, parentRssAfterBytes: process.memoryUsage().rss, sampledPeakParentRssBytes,
                childRssBeforeBytes: healthBefore.rssBytes, childRssAfterBytes: healthAfter.rssBytes,
                cpuParentUserMs: cpuUsage.user / 1000, cpuParentSystemMs: cpuUsage.system / 1000, cpuChildBefore: cpuChildBefore, cpuChildAfter: await childCpu(healthAfter.pid), durationMs,
                firstUncachedRequest: first, targetMs, targetApplicable: concurrency === 1,
                targetPassed: concurrency === 1 ? success.length === values.length && turnaround.p95Ms !== null && turnaround.p95Ms <= targetMs : null,
              })
            }
          }
        } finally { await runtime.dispose(); await client.shutdown() }
      }
    }
    const cpu = process.cpuUsage(overallCpu)
    return { samplesMinimum: samples, coldStarts, groups, durationMs: performance.now() - wallStarted,
      parentCpuUserMs: cpu.user / 1000, parentCpuSystemMs: cpu.system / 1000,
      singleConcurrencyTargetsPassed: groups.filter(g => g.targetApplicable).every(g => g.targetPassed),
      notes: "Full plugin runtime.toolBefore includes argument preparation, path canonicalization, bounded source reads, JSON transport, child scanning and hook decision. No tool action executes. Hit groups seed one exact evaluation request; miss groups vary evaluation source/path/command. Health cache hits include ancillary sanitizer operations, which full hooks may issue when rejecting overloaded writes. Parent RSS sampled every 5ms; child RSS sampled via health at group boundaries, not peak. CPU child is ps cumulative user+system clock, unavailable on unsupported platforms; a generation restart resets its clock. Warm targets apply only to concurrency=1 and require no failed requests; overloaded/timeout calls are retained separately. No performance CI gate." }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
