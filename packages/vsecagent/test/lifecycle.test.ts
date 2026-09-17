import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { VsecClient, VsecUnavailableError, type VsecClientOptions } from "../src/client"
const clients: VsecClient[] = [], dirs: string[] = []
const policy = { version: "vsec-1", exceptions: [], deniedPaths: [], mcpTools: {} }
const params = { namespace: { projectId: "project", sessionId: "session" }, policy, fields: ["hello"] }
const entry = fileURLToPath(new URL("./fixtures/child.ts", import.meta.url))
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.shutdown()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function create(mode: string, options: Partial<VsecClientOptions> = {}, delayMs = 100) {
  const dataDir = await mkdtemp(join(tmpdir(), "vsec-lifecycle-"))
  dirs.push(dataDir)
  await writeFile(join(dataDir, "fixture.json"), JSON.stringify({ mode, delayMs }))
  const client = await VsecClient.create({ dataDir, entry, ...options })
  clients.push(client)
  return client
}
test("deadline kills synchronously blocked child and restarts another generation", async () => {
  const client = await create("hang-once", { timeoutMs: 100 })
  const previous = await client.health()
  const start = performance.now()
  await expect(client.sanitize(params)).rejects.toMatchObject({ reason: "timeout" })
  expect(performance.now() - start).toBeLessThan(1000)
  expect((await client.sanitize(params)).fields).toEqual(["hello"])
  const current = await client.health()
  expect(current.pid).not.toBe(previous.pid)
  expect(() => process.kill(previous.pid, 0)).toThrow()
})
test("crash stderr is never exposed and a later request restarts", async () => {
  const client = await create("crash-once")
  await expect(client.sanitize(params)).rejects.toMatchObject({ reason: "crash", message: "Security scanner unavailable (crash)" })
  expect((await client.sanitize(params)).fields).toEqual(["hello"])
})
test("queue has a request-count bound and deadlines include waiting", async () => {
  const client = await create("delay", { maxQueuedRequests: 2, timeoutMs: 140 }, 100)
  const one = client.sanitize(params)
  const two = client.sanitize(params)
  const three = client.sanitize(params)
  const all = await Promise.allSettled([one, two, three])
  expect(all[0]?.status).toBe("fulfilled")
  expect(all[1]).toMatchObject({ status: "rejected", reason: { reason: "timeout" } })
  expect(all[2]).toMatchObject({ status: "rejected", reason: { reason: "overloaded" } })
})
test("queue bounds bytes and validates the entire field before enqueue", async () => {
  const client = await create("delay", { maxQueuedBytes: 1500 })
  const one = client.sanitize({ ...params, fields: ["x".repeat(800)] })
  await expect(client.sanitize({ ...params, fields: ["y".repeat(800)] })).rejects.toMatchObject({ reason: "overloaded" })
  await one
  await expect(client.sanitize({ ...params, fields: ["x".repeat(1024 * 1024 + 1)] })).rejects.toMatchObject({ reason: "input" })
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  await expect(client.evaluateTool({ ...params, tool: "read", args: cyclic, root: "/project", cwd: "/project", files: [], paths: [] })).rejects.toMatchObject({ reason: "input" })
})
test.each(["oversized", "invalid"])("rejects %s replies with fixed safe errors", async mode => {
  const client = await create(mode)
  try { await client.sanitize(params); throw new Error("expected rejection") }
  catch (error) {
    expect(error).toBeInstanceOf(VsecUnavailableError)
    expect((error as Error).message).toBe("Security scanner unavailable (protocol)")
  }
})
test("late duplicate reply cannot satisfy the next request", async () => {
  const client = await create("duplicate")
  expect((await client.sanitize(params)).fields).toEqual(["hello"])
  await Bun.sleep(20)
  expect((await client.sanitize({ ...params, fields: ["second"] })).fields).toEqual(["second"])
})
test("shutdown is idempotent and rejects subsequent calls", async () => {
  const client = await create("normal")
  const health = await client.health()
  await client.shutdown()
  await client.shutdown()
  expect(() => process.kill(health.pid, 0)).toThrow()
  await expect(client.sanitize(params)).rejects.toMatchObject({ reason: "closed" })
})
test("handshake rejects mismatched protocol", async () => {
  await expect(create("bad-start")).rejects.toMatchObject({ reason: "startup" })
})
