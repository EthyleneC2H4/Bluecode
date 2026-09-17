import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VsecClient } from "../src/client"

const clients: VsecClient[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.shutdown()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
export async function client() {
  const dataDir = await mkdtemp(join(tmpdir(), "vsec-client-"))
  dirs.push(dataDir)
  const client = await VsecClient.create({ dataDir })
  clients.push(client)
  return client
}
const policy = { version: "vsec-1", exceptions: [], deniedPaths: [], mcpTools: {} }
const namespace = { projectId: "project", sessionId: "session" }
test("warms an isolated child and sanitizes a credential before returning it", async () => {
  const scanner = await client()
  const health = await scanner.health()
  expect(health.pid).not.toBe(process.pid)
  expect(health.protocol).toBe(1)
  const result = await scanner.sanitize({ namespace, policy, fields: ["token=ghp_abcdefghijklmnopqrstuvwxyz123456789012"] })
  expect(result.fields[0]).not.toContain("ghp_")
  expect(result.redactions).toBe(1)
  expect(result.coverage).toBe("complete")
  const decision = await scanner.evaluateTool({ namespace, policy, tool: "bash", args: { command: "printf hello" }, root: "/project", cwd: "/project", files: [], paths: [] })
  expect(decision.decision).toBe("allow")
})

test("startup uses its own deadline even when scan budget is one millisecond", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vsec-startup-"))
  dirs.push(dataDir)
  const scanner = await VsecClient.create({ dataDir, timeoutMs: 1 })
  clients.push(scanner)
  expect(scanner).toBeInstanceOf(VsecClient)
})
test("32 concurrent calls preserve request identity and report queue and service timings", async () => {
  const scanner = await client()
  const results = await Promise.all(Array.from({ length: 32 }, (_, index) => scanner.sanitize({ namespace, policy, fields: [`field-${index}`] })))
  expect(new Set(results.map(result => result.requestId)).size).toBe(32)
  for (const [index, result] of results.entries()) {
    expect(result.fields).toEqual([`field-${index}`])
    expect(result.queueMs).toBeGreaterThanOrEqual(0)
    expect(result.serviceMs).toBeGreaterThanOrEqual(0)
    expect(result.policyVersion).toBe("vsec-1")
  }
  const health = await scanner.health()
  expect(health.rssBytes).toBeGreaterThan(0)
  expect(health.cacheBytes).toBeGreaterThan(0)
})

test("custom child entries can import the engine through the public package export", async () => {
  const moduleName = "@bluecode/vsecagent/engine"
  const entry = await import(moduleName).catch(() => undefined)
  expect(entry?.VsecEngine).toBeFunction()
})
