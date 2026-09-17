import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SecurityEvaluateParams } from "@bluecode/contracts"
import * as cache from "../src/cache"
import * as engine from "../src/engine"
import * as audit from "../src/audit"
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function directory() { const dir = await mkdtemp(join(tmpdir(), "vsec-infra-")); dirs.push(dir); return dir }
const namespace = { projectId: "project", sessionId: "session" }
const policy = { version: "vsec-1", exceptions: [], deniedPaths: [], mcpTools: {} }
const token = "ghp_Ab9cD8eF7gH6iJ5kL4mN3oP2qR1sT0uV9wX8"
const params = { namespace, policy, fields: [token] }
test("bounded LRU cache accounts UTF-8 bytes and expiry without retaining references", async () => {
  expect(cache.BoundedCache).toBeFunction()
  const store = new cache.BoundedCache(200)
  store.set("one", { fields: ["文".repeat(10)] }, Infinity)
  const found = store.get<{ fields: string[] }>("one")!
  found.fields[0] = "mutated"
  expect(store.get<{ fields: string[] }>("one")!.fields[0]).not.toBe("mutated")
  store.set("two", { text: "b".repeat(80) }, Infinity)
  store.set("three", { text: "c".repeat(80) }, Infinity)
  expect(store.bytes).toBeLessThanOrEqual(200)
  expect(store.get("one")).toBeUndefined()
  store.set("huge", { text: "x".repeat(201) }, Infinity)
  expect(store.get("huge")).toBeUndefined()
  store.set("expiry", { text: "gone" }, Date.now() + 10)
  await Bun.sleep(20)
  expect(store.get("expiry")).toBeUndefined()
})
test("cache keys isolate namespace, content, complete policy and parser versions", () => {
  expect(cache.cacheKey).toBeFunction()
  const key = cache.cacheKey("sanitize", params, "parser-1")
  expect(key).not.toContain(token)
  for (const variant of [
    { ...params, namespace: { ...namespace, projectId: "other" } },
    { ...params, namespace: { ...namespace, sessionId: "other" } },
    { ...params, policy: { ...policy, deniedPaths: ["/private"] } },
    { ...params, fields: ["other"] },
  ]) expect(cache.cacheKey("sanitize", variant, "parser-1")).not.toBe(key)
  expect(cache.cacheKey("sanitize", params, "parser-2")).not.toBe(key)
})
test("engine cache is scoped and expires exactly when a policy exception does", async () => {
  expect(engine.VsecEngine).toBeFunction()
  const scanner = await engine.VsecEngine.create({ dataDir: await directory() })
  const run = (op: "sanitize" | "evaluate", p: unknown) => scanner.request({ protocol: 1, id: crypto.randomUUID(), op, params: p, queueMs: 4 })
  const first = await run("sanitize", params)
  expect(JSON.stringify(first)).not.toContain(token)
  await run("sanitize", params)
  expect(scanner.health().cacheHits).toBe(1)
  await run("sanitize", { ...params, namespace: { ...namespace, sessionId: "other" } })
  expect(scanner.health().cacheHits).toBe(1)
  const evaluate: SecurityEvaluateParams = { namespace, policy, tool: "write", args: {}, root: "/project", cwd: "/project", files: [{ path: "/project/a.ts", content: `const token = '${token}'`, complete: true }], paths: [] }
  const baseline = await run("evaluate", evaluate)
  if (!baseline.ok || !("findings" in baseline.result)) throw new Error("expected decision")
  const ruleId = baseline.result.findings[0]!.ruleId
  evaluate.policy = { ...policy, exceptions: [{ ruleId, scope: "*", reason: "fixture", expiresAt: new Date(Date.now() + 80).toISOString() }] }
  const allowed = await run("evaluate", evaluate)
  expect(allowed).toMatchObject({ ok: true, result: { decision: "allow" } })
  await Bun.sleep(100)
  expect(await run("evaluate", evaluate)).toMatchObject({ ok: true, result: { decision: "deny" } })
  expect(scanner.health().cacheBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
})
test("audit rotation never persists raw evidence, identity strings, unsafe paths or messages", async () => {
  expect(audit.SafeAudit).toBeFunction()
  const dataDir = await directory()
  const log = await audit.SafeAudit.create({ dataDir, maxBytes: 2048, files: 3 })
  for (let index = 0; index < 40; index++) await log.write({ requestId: crypto.randomUUID(), operation: "evaluate", decision: "deny", policyVersion: `policy-${token}`, queueMs: 1, serviceMs: 2, findings: [{ ruleId: "credential.github", category: "credential", severity: "critical", confidence: "high", message: token, remediation: token, location: { path: `/secret/${token}`, line: 2, column: 3 } }] })
  const names = await readdir(join(dataDir, "audit"))
  expect(names.length).toBeLessThanOrEqual(3)
  let combined = ""
  for (const name of names) {
    const path = join(dataDir, "audit", name)
    expect((await stat(path)).size).toBeLessThanOrEqual(2048)
    expect((await stat(path)).mode & 0o077).toBe(0)
    combined += await readFile(path, "utf8")
  }
  expect(combined).not.toContain(token)
  expect(combined).not.toContain("/secret/")
  expect(combined).toContain("credential.github")
  expect(combined).toContain('"line":2')
})

test("redactor failures withhold every input field and are safely audited", async () => {
  const dataDir = await directory()
  const scanner = await engine.VsecEngine.create({ dataDir, redactor: { version: "mock", sanitize: async () => { throw new Error(token) } } })
  const result = await scanner.request({ protocol: 1, id: crypto.randomUUID(), op: "sanitize", params: { ...params, fields: [token, "ordinary content"] }, queueMs: 0 })
  expect(result).toMatchObject({ ok: true, result: { coverage: "unsupported", fields: ["[Security sanitization unavailable: content withheld]", "[Security sanitization unavailable: content withheld]"] } })
  expect(JSON.stringify(result)).not.toContain(token)
  const log = await readFile(join(dataDir, "audit/vsec.0.jsonl"), "utf8")
  expect(log).toContain("adapter-error")
  expect(log).not.toContain(token)
})
test("firewall denial combines with local checks and adapter failure becomes unavailable", async () => {
  const evaluate = { namespace, policy, tool: "read", args: {}, root: "/project", cwd: "/project", files: [], paths: [] }
  for (const fail of [false, true]) {
    const scanner = await engine.VsecEngine.create({ dataDir: await directory(), firewall: { version: "mock", evaluate: async () => {
      if (fail) throw new Error(token)
      return { decision: "deny", coverage: "complete", findings: [], diagnostics: [], policyVersion: "vsec-1" }
    } } })
    const result = await scanner.request({ protocol: 1, id: crypto.randomUUID(), op: "evaluate", params: evaluate, queueMs: 0 })
    expect(result).toMatchObject({ ok: true, result: { decision: fail ? "unavailable" : "deny" } })
  }
})
test("exception expiring during a slow adapter call cannot create an immortal allow cache entry", async () => {
  const scanner = await engine.VsecEngine.create({ dataDir: await directory(), firewall: { version: "mock", evaluate: async () => {
    await Bun.sleep(60)
    return { decision: "allow", coverage: "complete", findings: [], diagnostics: [], policyVersion: "vsec-1" }
  } } })
  const evaluate = { namespace, policy: { ...policy, exceptions: [{ ruleId: "credential.github", scope: "*", reason: "fixture", expiresAt: new Date(Date.now() + 30).toISOString() }] }, tool: "write", args: {}, root: "/project", cwd: "/project", files: [{ path: "/project/a.ts", content: token, complete: true }], paths: [] }
  const run = () => scanner.request({ protocol: 1, id: crypto.randomUUID(), op: "evaluate", params: evaluate, queueMs: 0 })
  await run()
  expect(await run()).toMatchObject({ ok: true, result: { decision: "deny" } })
  expect(scanner.health().cacheHits).toBe(0)
})

test("failed requests retain safe correlation and timing metadata", async () => {
  const scanner = await engine.VsecEngine.create({ dataDir: await directory() })
  const id = crypto.randomUUID()
  const result = await scanner.request({ protocol: 1, id, op: "sanitize", params: { fields: [token], policy: { version: token } }, queueMs: 4 })
  expect(result).toMatchObject({ ok: false, error: "input", timing: { requestId: id, queueMs: 4, policyVersion: "invalid-policy" } })
  expect(JSON.stringify(result)).not.toContain(token)
})
