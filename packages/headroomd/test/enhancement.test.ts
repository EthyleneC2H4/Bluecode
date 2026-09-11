import { expect, test } from "bun:test"
import { summaryProviderSchema } from "@bluecode/contracts"
import { EnhancementManager } from "../src/enhancement"
import { OpenAICompatibleSummaryProvider, type SummaryProvider } from "../src/summary-provider"

const cfg = (extra = {}) => summaryProviderSchema.parse({ enabled: true, baseURL: "http://localhost/v1", model: "test", apiKeyEnv: "BLUECODE_SUMMARY_TEST_KEY", ...extra })
const input = (sessionId = "s", sourceKey = "v1") => ({ namespace: { projectId: "p", sessionId }, sourceKey, sourceIds: ["a"], material: "irrelevant old log line\n".repeat(100) })
const entries = [{ kind: "decisions" as const, text: "Keep concise.", sourceIds: ["a"] }]
const provider: SummaryProvider = { model: "test", async summarize() { return { entries, usage: { inputTokens: 300, outputTokens: 30 } } } }

test("submits immediately, caches validated results, and rejects stale source", async () => {
  let calls = 0
  const manager = new EnhancementManager({ ...provider, async summarize(r) { calls++; return provider.summarize(r) } }, cfg())
  const job = manager.submit(input())
  expect(job.status).toBe("queued")
  await manager.awaitIdle()
  expect(manager.get(job.jobId)?.status).toBe("completed")
  expect(manager.submit(input()).jobId).toBe(job.jobId)
  expect(calls).toBe(1)
  expect(manager.get(job.jobId, "edited")?.status).toBe("rejected")
  manager.dispose()
})

test("reserves budgets before parallel admission, retains unknown error cost, and bounds sessions", async () => {
  const manager = new EnhancementManager({ model: "test", async summarize() { throw new Error("secret must not leak") } }, cfg({ sessionInputTokens: 8192, sessionOutputTokens: 1024 }))
  const first = manager.submit(input())
  expect(manager.submit(input("s", "v2")).reason).toBe("session-busy")
  await manager.awaitIdle()
  expect(manager.get(first.jobId)?.reason).toBe("provider-error")
  expect(manager.get(first.jobId)?.usage).toEqual({ inputTokens: null, outputTokens: null })
  expect(manager.submit(input("s", "v2")).reason).toBe("session-budget")
  manager.dispose()
})

test("rejects forged sources, protected constraint rewrites, output inflation and oversized envelope", async () => {
  for (const bad of [ [{ ...entries[0]!, sourceIds: ["forged"] }], [{ ...entries[0]!, kind: "constraints" as const }], [{ ...entries[0]!, text: "larger".repeat(4000) }] ]) {
    const manager = new EnhancementManager({ ...provider, async summarize() { return { entries: bad, usage: { inputTokens: 100, outputTokens: 50 } } } }, cfg())
    const job = manager.submit(input())
    await manager.awaitIdle()
    expect(manager.get(job.jobId)?.status).toBe("rejected")
    expect(manager.get(job.jobId)?.usage?.outputTokens).toBe(50)
    manager.dispose()
  }
  const manager = new EnhancementManager(provider, cfg({ maxInputTokens: 20 }))
  expect(manager.submit({ ...input(), material: "tiny", state: { instructions: "x".repeat(1000) } }).reason).toBe("input-budget")
  manager.dispose()
})

test("global admission runs two, queues bounded work, and cancellation releases slots", async () => {
  let active = 0, peak = 0
  const manager = new EnhancementManager({ model: "test", async summarize({ signal }) {
    active++; peak = Math.max(peak, active)
    try { await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) }
    finally { active-- }
    return { entries, usage: { inputTokens: null, outputTokens: null } }
  } }, cfg())
  const jobs = Array.from({ length: 30 }, (_, i) => manager.submit(input(String(i))))
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(peak).toBe(2)
  expect(jobs.filter(job => job.reason === "queue-full").length).toBeGreaterThan(0)
  manager.dispose()
  await manager.awaitIdle()
  expect(active).toBe(0)
  expect(manager.submit(input("new")).reason).toBe("disposed")
})

test("native fetch sends nonstreaming request, reads environment credential and preserves actual/missing usage", async () => {
  process.env.BLUECODE_SUMMARY_TEST_KEY = "fixture-only"
  let observed: any
  const server = Bun.serve({ port: 0, async fetch(request) {
    observed = { path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ entries }) } }], usage: { prompt_tokens: 101, completion_tokens: 23 } })
  } })
  try {
    const adapter = new OpenAICompatibleSummaryProvider(cfg({ baseURL: `http://localhost:${server.port}/v1` }))
    const result = await adapter.summarize({ messages: [{ role: "user", content: "source" }], maxOutputTokens: 100, signal: new AbortController().signal })
    expect(result.usage).toEqual({ inputTokens: 101, outputTokens: 23 })
    expect(observed.path).toBe("/v1/chat/completions")
    expect(observed.authorization).toBe("Bearer fixture-only")
    expect(observed.body.stream).toBe(false)
    expect(observed.body.max_tokens).toBe(100)
  } finally { server.stop(true); delete process.env.BLUECODE_SUMMARY_TEST_KEY }
})

test("HTTP malformed response and timeout fail safely without body/credential disclosure", async () => {
  process.env.BLUECODE_SUMMARY_TEST_KEY = "fixture-only"
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.startsWith("/slow")) { await new Promise(resolve => setTimeout(resolve, 100)); return new Response("late") }
    return new Response("private provider response")
  } })
  try {
    for (const path of ["/bad", "/slow"]) {
      const config = cfg({ baseURL: `http://localhost:${server.port}${path}`, timeoutMs: 20 })
      const manager = new EnhancementManager(new OpenAICompatibleSummaryProvider(config), config)
      const job = manager.submit(input())
      await manager.awaitIdle()
      expect(manager.get(job.jobId)?.status).toBe("failed")
      expect(JSON.stringify(manager.get(job.jobId))).not.toContain("private provider")
      manager.dispose()
    }
  } finally { server.stop(true); delete process.env.BLUECODE_SUMMARY_TEST_KEY }
})

test("restored spent budgets cannot decrease or reset through namespace admission", async () => {
  const manager = new EnhancementManager(provider, cfg())
  const namespace = input().namespace
  manager.restoreUsage(namespace, { inputTokens: 32768, outputTokens: 4096 })
  manager.restoreUsage(namespace, { inputTokens: 0, outputTokens: 0 })
  expect(manager.sessionUsage(namespace)).toEqual({ inputTokens: 32768, outputTokens: 4096 })
  expect(manager.submit(input()).reason).toBe("session-budget")
  for (let i = 0; i < 127; i++) manager.restoreUsage({ projectId: "p", sessionId: String(i) }, { inputTokens: 1, outputTokens: 1 })
  expect(manager.submit(input("overflow")).reason).toBe("session-capacity")
  manager.dispose()
})

test("queued cancellation refunds unspent reservations; successful unknown usage consumes full ceiling", async () => {
  const manager = new EnhancementManager({ model: "test", async summarize() { return { entries, usage: { inputTokens: null, outputTokens: null } } } }, cfg())
  const job = manager.submit(input())
  expect(manager.sessionUsage(input().namespace)).toEqual({ inputTokens: 8192, outputTokens: 1024 })
  manager.cancel(job.jobId)
  expect(manager.sessionUsage(input().namespace)).toEqual({ inputTokens: 0, outputTokens: 0 })
  const next = manager.submit(input())
  await manager.awaitIdle()
  expect(manager.get(next.jobId)?.usage).toEqual({ inputTokens: null, outputTokens: null })
  expect(manager.sessionUsage(input().namespace)).toEqual({ inputTokens: 8192, outputTokens: 1024 })
  expect(manager.stats().running).toBe(0)
  manager.dispose()
})

test("invalid summary JSON still preserves provider-reported usage; provider overages reject and charge actual", async () => {
  process.env.BLUECODE_SUMMARY_TEST_KEY = "fixture-only"
  const server = Bun.serve({ port: 0, fetch() { return Response.json({ choices: [{ message: { content: "not JSON" } }], usage: { prompt_tokens: 99, completion_tokens: 33 } }) } })
  try {
    const config = cfg({ baseURL: `http://localhost:${server.port}/v1` })
    const manager = new EnhancementManager(new OpenAICompatibleSummaryProvider(config), config)
    const job = manager.submit(input())
    await manager.awaitIdle()
    expect(manager.get(job.jobId)?.usage).toEqual({ inputTokens: 99, outputTokens: 33 })
    expect(manager.sessionUsage(input().namespace)).toEqual({ inputTokens: 99, outputTokens: 33 })
    manager.dispose()
    const excessive = new EnhancementManager({ ...provider, async summarize() { return { entries, usage: { inputTokens: 9000, outputTokens: 1200 } } } }, cfg())
    const over = excessive.submit(input())
    await excessive.awaitIdle()
    expect(excessive.get(over.jobId)?.reason).toBe("provider-budget")
    expect(excessive.sessionUsage(input().namespace)).toEqual({ inputTokens: 9000, outputTokens: 1200 })
    excessive.dispose()
  } finally { server.stop(true); delete process.env.BLUECODE_SUMMARY_TEST_KEY }
})

test("restoring while active preserves the live reservation ledger", async () => {
  const manager = new EnhancementManager(provider, cfg())
  manager.submit(input())
  manager.restoreUsage(input().namespace, manager.sessionUsage(input().namespace))
  await manager.awaitIdle()
  expect(manager.sessionUsage(input().namespace)).toEqual({ inputTokens: 300, outputTokens: 30 })
  manager.dispose()
})

test("completed job and cache memory stay bounded without resetting session spend", async () => {
  const manager = new EnhancementManager({ ...provider, async summarize() { return { entries, usage: { inputTokens: 1, outputTokens: 1 } } } }, cfg())
  for (let i = 0; i < 530; i++) { manager.submit(input("s", String(i))); await manager.awaitIdle() }
  expect(manager.stats().jobs).toBe(512)
  expect(manager.stats().cached).toBe(128)
  expect(manager.sessionUsage(input().namespace)).toEqual({ inputTokens: 530, outputTokens: 530 })
  manager.dispose()
})

function deferredProvider() {
  let active = 0, peak = 0
  const calls: Array<{ signal: AbortSignal; finish: () => void }> = []
  const summary: SummaryProvider = { model: "test", summarize({ signal }) {
    active++; peak = Math.max(peak, active)
    return new Promise(resolve => calls.push({ signal, finish() { active--; resolve({ entries, usage: { inputTokens: 100, outputTokens: 20 } }) } }))
  } }
  return { summary, calls, get active() { return active }, get peak() { return peak } }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test("timeout reports failure but retains permits until delayed provider cleanup really settles", async () => {
  const deferred = deferredProvider()
  const manager = new EnhancementManager(deferred.summary, cfg({ timeoutMs: 5 }))
  const jobs = Array.from({ length: 6 }, (_, i) => manager.submit(input(String(i))))
  await tick()
  const aborted = deferred.calls.slice(0, 2).map(call => call.signal.aborted ? Promise.resolve() : new Promise<void>(resolve => call.signal.addEventListener("abort", () => resolve(), { once: true })))
  await Promise.all(aborted)
  await tick()
  let idle = false
  void manager.awaitIdle().then(() => { idle = true })
  try {
    expect(jobs.slice(0, 2).map(job => manager.get(job.jobId)?.status)).toEqual(["failed", "failed"])
    expect(manager.stats().running).toBe(2)
    expect(manager.stats().queued).toBe(4)
    expect(deferred.peak).toBe(2)
    expect(idle).toBe(false)
    expect(manager.submit(input("0", "replacement")).reason).toBe("session-busy")
    deferred.calls[0]!.finish()
    await tick()
    expect(deferred.calls.length).toBe(3)
    expect(deferred.active).toBe(2)
    expect(deferred.peak).toBe(2)
    expect(manager.get(jobs[0]!.jobId)?.entries).toBeUndefined()
    expect(manager.get(jobs[0]!.jobId)?.status).toBe("failed")
    expect(manager.submit(input("0", "replacement")).status).toBe("queued")
  } finally {
    manager.dispose()
    for (const call of deferred.calls.slice(1)) call.finish()
    await manager.awaitIdle()
  }
})

test("cancel and dispose return immediately but awaitIdle and same-session admission await actual cleanup", async () => {
  const deferred = deferredProvider()
  const manager = new EnhancementManager(deferred.summary, cfg())
  const job = manager.submit(input())
  await tick()
  manager.cancel(job.jobId)
  await tick()
  let idle = false
  void manager.awaitIdle().then(() => { idle = true })
  try {
    expect(manager.get(job.jobId)?.status).toBe("cancelled")
    expect(manager.submit(input("s", "replacement")).reason).toBe("session-busy")
    expect(manager.dispose()).toBeUndefined()
    await tick()
    expect(deferred.calls[0]!.signal.aborted).toBe(true)
    expect(manager.stats().running).toBe(1)
    expect(idle).toBe(false)
  } finally {
    manager.dispose()
    deferred.calls[0]!.finish()
    await manager.awaitIdle()
  }
  expect(idle).toBe(true)
  expect(manager.stats().running).toBe(0)
  expect(manager.get(job.jobId)?.entries).toBeUndefined()
  expect(manager.get(job.jobId)?.status).toBe("cancelled")
})
