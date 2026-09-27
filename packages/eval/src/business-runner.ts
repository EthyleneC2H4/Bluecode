import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { checkBusinessTask, prepareBusinessTask } from "./business-acceptance"
import { dockerBusinessService } from "./business-container"
import { makeBusinessConfig, BUSINESS_MODEL, BUSINESS_UPSTREAM_MODEL } from "./business-config"
import { plannedBusinessRuns, summarizeBusinessRuns, type PlannedBusinessRun, type BusinessRecord } from "./business-experiment"
import { seedBusinessHistory } from "./business-history"
import { createBusinessProxy } from "./business-proxy"
import { command } from "./live-process"

const repository = resolve(import.meta.dir, "../../..")
const deadlineMs = 600_000
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const redact = (text: string, secrets: string[]) => secrets.reduce((value, secret) => secret ? value.replaceAll(secret, "[redacted]") : value, text).replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")

export function consumedHeadroom(trace: any[], requests: Array<{ sequence: number; headroomNodeIds: string[] }>) {
  return trace.some(applied => applied.type === "runtime" && applied.stage === "transform" && applied.reason === "view"
    && applied.details?.status === "applied" && trace.some(view => view.type === "transform" && view.sequence > applied.sequence
      && Array.isArray(view.nodeIds) && view.nodeIds.length > 0 && requests.some(request => request.sequence > view.sequence
        && request.headroomNodeIds.some(id => view.nodeIds.includes(id)))))
}

export function classifyBusinessFailure(input: { timedOut: boolean; aborted: boolean; budgetExhausted: boolean;
  modelStatuses: Array<number | "transport-error">; pluginLoaded: boolean; exitCode: number; outputTruncated: boolean;
  serviceStarted: boolean; acceptancePassed: boolean }) {
  if (input.timedOut) return "timeout"
  if (input.aborted) return "canceled"
  if (input.budgetExhausted) return "budget_exhausted"
  if (input.modelStatuses.some(status => status === "transport-error" || status >= 400)) return "model_or_proxy_error"
  if (!input.pluginLoaded || input.exitCode !== 0 || input.outputTruncated || input.modelStatuses.length === 0 || !input.serviceStarted) return "environment_error"
  return input.acceptancePassed ? null : "business_error"
}

function offlineResponse(action: "history" | "test" | null = null) {
  const base = { id: "chatcmpl-business-offline", object: "chat.completion.chunk", created: 1, model: BUSINESS_UPSTREAM_MODEL }
  const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const body = action
    ? chunk({ role: "assistant", tool_calls: [{ index: 0, id: action === "history" ? "call_business_history" : "call_business_test", type: "function", function: {
      name: "bash", arguments: JSON.stringify(action === "history" ? { command: "bun run inspect:history", description: "Inspect frozen pressure output" }
        : { command: "bun test", description: "Check public business test" }),
    } }] }) + chunk({}, "tool_calls")
    : chunk({ role: "assistant", content: "Offline harness check completed. No business code was changed." }) + chunk({}, "stop")
  return new Response(body + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } })
}

export interface BusinessRunOptions {
  mode: "offline" | "online"
  image: string
  outputDir: string
  apiKeyEnv?: string
  freeModelCheckedAt?: string
  runs?: PlannedBusinessRun[]
}

async function imageMetadata(image: string) {
  const inspected = await command(["docker", "image", "inspect", image, "--format", "{{.Id}}"], repository, {}, 10000)
  if (inspected.code !== 0) throw Error(`Business runtime image unavailable: ${image}`)
  const version = await command(["docker", "run", "--rm", image, "opencode", "--version"], repository, {}, 20000)
  if (version.code !== 0 || version.stdout.trim() !== "1.18.23") throw Error("Business image requires OpenCode 1.18.23")
  const bun = await command(["docker", "run", "--rm", image, "bun", "--version"], repository, {}, 20000)
  if (bun.code !== 0) throw Error("Business image Bun runtime unavailable")
  return { digest: inspected.stdout.trim(), hostVersion: version.stdout.trim(), bunVersion: bun.stdout.trim() }
}

async function taskDigest(task: PlannedBusinessRun["task"]) {
  const files = ["base/package.json", "base/src/operations.ts", "base/src/server.ts", "base/test/public.test.ts", `tasks/${task}/TASK.md`, `tasks/${task}/seed.json`]
  const root = join(repository, "packages/eval/fixtures/order-after-sales")
  return sha256((await Promise.all(files.map(async file => `${file}\n${await readFile(join(root, file), "utf8")}`))).join("\n"))
}

async function writePressureFiles(work: string, artifacts: string, sessionId: string) {
  await writeFile(join(artifacts, "history.json"), json(seedBusinessHistory("/workspace", sessionId)))
  await writeFile(join(work, "pressure-log.ts"), `for (let i = 0; i < 180; i++) console.log(\`✓ \${i + 1} - order after-sales audit: cumulative quantity, cents and retry identity must remain consistent\`)\n`)
  const manifest = JSON.parse(await readFile(join(work, "package.json"), "utf8"))
  manifest.scripts["inspect:history"] = "bun pressure-log.ts"
  await writeFile(join(work, "package.json"), json(manifest))
}

function entrypoint() {
  return `#!/bin/sh
set -eu
if [ -f /artifacts/history.json ]; then
  opencode import --pure /artifacts/history.json > /artifacts/import.log
  exec opencode run --format json --model '${BUSINESS_MODEL}' --session "$BUSINESS_SESSION_ID" --title "Business $BUSINESS_RUN_ID" --dir /workspace "$BUSINESS_PROMPT"
fi
exec opencode run --format json --model '${BUSINESS_MODEL}' --title "Business $BUSINESS_RUN_ID" --dir /workspace "$BUSINESS_PROMPT"
`
}

async function runOne(run: PlannedBusinessRun, options: BusinessRunOptions, image: Awaited<ReturnType<typeof imageMetadata>>,
  proxy: ReturnType<typeof createBusinessProxy>, upstreamKey: string): Promise<BusinessRecord & Record<string, unknown>> {
  const root = join(resolve(options.outputDir), "runs", run.id)
  await mkdir(root)
  const work = join(root, "work"), source = join(root, "source"), artifacts = join(root, "artifacts")
  await mkdir(artifacts)
  await prepareBusinessTask(run.task, work)
  const sessionId = `ses_${randomUUID().replaceAll("-", "")}`
  if (run.kind === "pressure") await writePressureFiles(work, artifacts, sessionId)
  await cp(work, source, { recursive: true })
  const config = makeBusinessConfig(run.arm, run.id, proxy.port)
  const startedAt = new Date().toISOString()
  const gitHead = (await command(["git", "rev-parse", "HEAD"], repository, {}, 10000)).stdout.trim()
  const evaluatorDigest = sha256((await Promise.all(["business-runner.ts", "business-proxy.ts", "business-acceptance.ts", "business-container.ts", "business-config.ts", "business-history.ts"]
    .map(async file => `${file}\n${await readFile(join(import.meta.dir, file), "utf8")}`))).join("\n"))
  const manifest = { schema: 1, mode: options.mode, run, startedAt, gitHead, image: { name: options.image, ...image }, taskDigest: await taskDigest(run.task),
    evaluatorDigest, model: { host: BUSINESS_MODEL, upstream: BUSINESS_UPSTREAM_MODEL, pricingCheckedOn: options.freeModelCheckedAt ?? null, pricingSource: "https://opencode.ai/docs/zen/#pricing" },
    budgets: { maxRequests: 8, maxDurationMs: deadlineMs, maxInputPerRequest: 40000, maxOutputPerRequest: 2048 },
    pluginEffective: config.effective, hostConfig: config.host, taskContract: `work/TASK.md`,
    usagePolicy: "Provider response tokens only; missing usage remains null. Reservations and imported seed tokens are separate." }
  await writeFile(join(root, "manifest.json"), json(manifest))
  await writeFile(join(artifacts, "entrypoint.sh"), entrypoint())
  const token = proxy.register(run.id, BUSINESS_UPSTREAM_MODEL, Date.now() + deadlineMs)
  const tokenFile = join(root, ".run-token.env")
  await writeFile(tokenFile, `BLUECODE_RUN_TOKEN=${token}\nBLUECODE_BUSINESS_TRACE_TOKEN=${proxy.traceToken(run.id)}\n`, { mode: 0o600 })
  const name = `bluecode-run-${randomUUID().replaceAll("-", "").slice(0, 20)}`
  const prompt = run.kind === "pressure"
    ? "请先运行 bun run inspect:history，阅读 TASK.md，严格保留累计退款、状态和幂等约束，完成 T3 后运行 bun test。"
    : "阅读 TASK.md，完成指定订单或售后任务，并运行 bun test。"
  const env = [
    `OPENCODE_CONFIG_CONTENT=${JSON.stringify(config.host)}`,
    "OPENCODE_DISABLE_MODELS_FETCH=true", "OPENCODE_DISABLE_DEFAULT_PLUGINS=true", "OPENCODE_DISABLE_AUTOUPDATE=true",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS=true", "OPENCODE_DISABLE_CLAUDE_CODE=true", "OPENCODE_DISABLE_LSP_DOWNLOAD=true",
    "DO_NOT_TRACK=1", "HOME=/artifacts/home", "XDG_CONFIG_HOME=/artifacts/config", "XDG_DATA_HOME=/artifacts/data",
    "XDG_STATE_HOME=/artifacts/state", "XDG_CACHE_HOME=/artifacts/cache",
    `BLUECODE_BUSINESS_TRACE_URL=http://host.docker.internal:${proxy.port}/${run.id}/trace`,
    `BUSINESS_RUN_ID=${run.id}`, `BUSINESS_SESSION_ID=${sessionId}`, `BUSINESS_PROMPT=${prompt}`,
  ]
  const argv = ["docker", "run", "--rm", "--name", name, "--init", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=256", "--memory=2g", "--cpus=2", "--network=bridge", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
    "--mount", `type=bind,source=${work},target=/workspace`, "--mount", `type=bind,source=${artifacts},target=/artifacts`, "--env-file", tokenFile,
    ...env.flatMap(value => ["-e", value]), options.image, "sh", "/artifacts/entrypoint.sh"]
  let execution: Awaited<ReturnType<typeof command>> | null = null
  let budgetSnapshot: ReturnType<typeof proxy.budget> = null
  let traceSnapshot: ReturnType<typeof proxy.trace> = []
  const start = performance.now()
  try { execution = await command(argv, repository, {}, deadlineMs) }
  finally {
    await command(["docker", "rm", "-f", name], repository, {}, 10000).catch(() => undefined)
    budgetSnapshot = proxy.budget(run.id)
    traceSnapshot = proxy.trace(run.id)
    proxy.revoke(run.id)
    await rm(tokenFile, { force: true })
  }
  const durationMs = performance.now() - start
  const requests = proxy.records(run.id)
  const trace = traceSnapshot as any[]
  await writeFile(join(root, "trace.jsonl"), trace.map(event => JSON.stringify(event)).join("\n") + (trace.length ? "\n" : ""))
  const patch = await command(["diff", "-ruN", "--exclude=data", source, work], repository, {}, 10000)
  await writeFile(join(root, "patch.diff"), redact(patch.stdout, [token, upstreamKey]))
  await writeFile(join(root, "events.jsonl"), redact(execution.stdout, [token, upstreamKey]))
  await writeFile(join(root, "stderr.txt"), redact(execution.stderr, [token, upstreamKey]))
  const acceptance = await checkBusinessTask(run.task, work, dockerBusinessService(options.image))
  await writeFile(join(root, "acceptance.json"), json(acceptance))
  await writeFile(join(root, "request-usage.json"), json({ requests, budget: budgetSnapshot }))
  const sum = (field: "actualInput" | "actualOutput" | "cacheRead" | "cacheWrite") => requests.length && requests.every(record => record[field] !== null)
    ? requests.reduce((total, record) => total + record[field]!, 0) : null
  const tools = execution.stdout.split("\n").flatMap(line => { try { const event = JSON.parse(line); return event.type === "tool_use" ? [event.part?.tool ?? "unknown"] : [] } catch { return [] } })
  const toolCounts: Record<string, number> = {}
  for (const tool of tools) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1
  const rtkCompressed = trace.filter(event => event.type === "tool" && event.rtkCompressed === true)
  const securityWithheld = trace.filter(event => event.type === "tool" && event.securityWithheld === true)
  const headroomGenerated = trace.some(event => event.type === "runtime" && event.stage === "publish" && event.reason === "ready")
  const headroomApplied = trace.some(event => event.type === "runtime" && event.stage === "transform" && event.reason === "view" && event.details?.status === "applied")
  const headroomConsumed = consumedHeadroom(trace, requests)
  const compressionExercised = rtkCompressed.length > 0 || headroomConsumed
  const pluginLoaded = trace.some(event => event.type === "factory")
  const harnessPassed = execution.code === 0 && !execution.timedOut && !execution.outputTruncated && requests.length > 0 && pluginLoaded
  const failureType = classifyBusinessFailure({ timedOut: execution.timedOut, aborted: execution.aborted,
    budgetExhausted: budgetSnapshot?.exhausted === true, modelStatuses: requests.map(request => request.status), pluginLoaded,
    exitCode: execution.code, outputTruncated: execution.outputTruncated,
    serviceStarted: !acceptance.checks.some(check => check.name === "service-start"), acceptancePassed: acceptance.passed })
  const record = { ...run, mode: options.mode, passed: harnessPassed && failureType === null, failureType, durationMs,
    actualInput: sum("actualInput"), actualOutput: sum("actualOutput"),
    cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), compressionExercised,
    flags: run.arm === "combo" && !compressionExercised ? ["compression_not_exercised"] : [],
    exitCode: execution.code, timedOut: execution.timedOut, outputTruncated: execution.outputTruncated, harnessPassed, pluginLoaded,
    modelRequests: requests.length, modelRetries: null, toolCounts, budget: budgetSnapshot,
    rtk: { compressedOutputs: rtkCompressed.length, beforeChars: rtkCompressed.reduce((n, event) => n + (event.beforeChars ?? 0), 0),
      afterChars: rtkCompressed.reduce((n, event) => n + (event.afterChars ?? 0), 0) },
    security: { withheldOutputs: securityWithheld.length, withheldChars: securityWithheld.reduce((n, event) => n + Math.max(0, (event.beforeChars ?? 0) - (event.afterChars ?? 0)), 0) },
    headroom: { generated: headroomGenerated, applied: headroomApplied, consumed: headroomConsumed },
    acceptance: Object.fromEntries(acceptance.checks.map(check => [check.name, check.passed])), finishedAt: new Date().toISOString() }
  await writeFile(join(root, "result.json"), json(record))
  return record
}

export async function runBusinessEvaluation(options: BusinessRunOptions) {
  const key = options.mode === "online" ? process.env[options.apiKeyEnv ?? "BLUECODE_ZEN_API_KEY"] : "offline-fixture-key"
  if (!key) throw Error("Missing free-model credential; online runs remain pending")
  if (options.mode === "online" && !/^\d{4}-\d{2}-\d{2}$/.test(options.freeModelCheckedAt ?? "")) throw Error("Online runs require a fresh official free-model pricing check date")
  const runs = options.runs ?? (options.mode === "offline" ? plannedBusinessRuns().slice(0, 2) : plannedBusinessRuns())
  if (runs.some(run => !plannedBusinessRuns().some(frozen => JSON.stringify(frozen) === JSON.stringify(run)))) throw Error("Run outside frozen matrix")
  await mkdir(resolve(options.outputDir), { recursive: true })
  try { await mkdir(join(resolve(options.outputDir), "runs")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("Business output already contains runs; choose a new output directory")
    throw error }
  const image = await imageMetadata(options.image)
  let activeRun: PlannedBusinessRun | null = null, offlineCalls = 0
  const proxy = createBusinessProxy({ upstreamKey: key, ...(options.mode === "offline" ? { upstreamFetch: async () => {
    if (activeRun?.kind !== "pressure") return offlineResponse()
    const call = offlineCalls++
    if (call === 1) await Bun.sleep(700)
    return offlineResponse(call === 0 ? "history" : call === 1 ? "test" : null)
  } } : {}) })
  const records: Array<BusinessRecord & Record<string, unknown>> = []
  try {
    for (const run of runs) {
      activeRun = run; offlineCalls = 0
      const record = await runOne(run, options, image, proxy, key).catch(async error => {
        const reason = redact(error instanceof Error ? error.message : String(error), [key])
        const failed = { ...run, mode: options.mode, passed: false, failureType: "environment_error", durationMs: null, actualInput: null, actualOutput: null,
          compressionExercised: false, harnessPassed: false, reason }
        const root = join(resolve(options.outputDir), "runs", run.id)
        await mkdir(root, { recursive: true })
        await writeFile(join(root, "result.json"), json(failed))
        return failed
      })
      records.push(record)
      await writeFile(join(resolve(options.outputDir), "ledger.json"), json({ schema: 1, mode: options.mode, planned: runs, completed: records.map(record => record.id), pending: runs.filter(item => !records.some(record => record.id === item.id)).map(item => item.id), records }))
      await writeFile(join(resolve(options.outputDir), "summary.json"), json(summarizeBusinessRuns(records)))
    }
  } finally { proxy.stop() }
  return { records, summary: summarizeBusinessRuns(records) }
}

export async function cleanupBusinessRun(outputDir: string, runId: string) {
  if (!plannedBusinessRuns().some(run => run.id === runId)) throw Error("Unknown frozen run")
  const root = join(resolve(outputDir), "runs", runId)
  await stat(join(root, "result.json"))
  await rm(join(root, "work"), { recursive: true, force: true })
  await rm(join(root, "source"), { recursive: true, force: true })
  for (const directory of ["home", "config", "cache", "state"]) await rm(join(root, "artifacts", directory), { recursive: true, force: true })
}
