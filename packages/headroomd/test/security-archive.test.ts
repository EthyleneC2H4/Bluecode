import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { securityPolicySchema, type ChatMessage } from "@bluecode/contracts"
import { createEngine } from "../src/engine"
import { EnhancementManager } from "../src/enhancement"
import { createArchiveSecurity } from "../src/security"

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
const policy = securityPolicySchema.parse({})
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true }) })
async function directory() { const dir = await mkdtemp(join(tmpdir(), "vsec-archive-")); dirs.push(dir); return dir }
function messages(secret = false): ChatMessage[] {
  return Array.from({ length: 5 }, (_, i) => [
    { info: { id: `u${i}`, role: "user" as const }, parts: [{ type: "text" as const, text: `Inspect version ${i}` }] },
    { info: { id: `a${i}`, role: "assistant" as const }, parts: [{ type: "tool" as const, tool: "read", input: { filePath: `src/${i}.ts` },
      state: { status: "completed", output: `function f${i}() { return 1 }\n`.repeat(100) + (secret ? SECRET : "") } }] },
  ]).flat()
}
const params = (secret = false) => ({ projectId: "p", sessionId: "s", messages: messages(secret), strategy: "layered" as const,
  contextWindowTokens: 8000, targetTokens: 4000, triggerRatio: .7, retainRecentTurns: 1 })

test("secure archive rejects raw credentials before any source or index persistence", async () => {
  const dataDir = await directory()
  const engine = await createEngine({ dataDir, securityPolicy: policy } as any)
  try {
    await expect(engine.compress(params(true))).rejects.toThrow("security")
    expect(engine.sessionCount()).toBe(0)
    for (const file of await readdir(dataDir)) if (file.endsWith(".db") || file.endsWith("-wal"))
      expect((await readFile(join(dataDir, file))).includes(Buffer.from(SECRET))).toBe(false)
    expect((await engine.compress(params())).compacted).toBe(true)
  } finally { engine.close() }
})

test("policy-bound storage refuses downgrade, another policy and implicit legacy migration", async () => {
  const dataDir = await directory()
  const engine = await createEngine({ dataDir, securityPolicy: policy } as any); engine.close()
  await expect(createEngine({ dataDir })).rejects.toThrow("security")
  await expect(createEngine({ dataDir, securityPolicy: { ...policy, version: "different" } } as any)).rejects.toThrow("security")
  const legacy = await directory(); (await createEngine({ dataDir: legacy })).close()
  await expect(createEngine({ dataDir: legacy, securityPolicy: policy } as any)).rejects.toThrow("security")
})

test("summary output is sanitized before caching and source inputs must already be clean", async () => {
  const guard = createArchiveSecurity(policy)
  let called = 0
  const manager = new EnhancementManager({ model: "mock", async summarize() {
    called++; return { entries: [{ kind: "changes", text: `Removed credential ${SECRET}`, sourceIds: ["a"] }], usage: { inputTokens: 100, outputTokens: 20 } }
  } }, { enabled: true, model: "mock", baseURL: "http://127.0.0.1:1/v1", apiKeyEnv: "VSEC_MOCK_UNUSED", maxInputTokens: 8192, maxOutputTokens: 1024,
    sessionInputTokens: 32768, sessionOutputTokens: 4096, timeoutMs: 1000 }, undefined, guard)
  try {
    const input = { namespace: { projectId: "p", sessionId: "s" }, sourceKey: "safe", sourceIds: ["a"], material: "Reviewed source and kept compatible API. ".repeat(150) }
    const job = manager.submit(input); await manager.awaitIdle()
    expect(manager.get(job.jobId)?.status).toBe("completed")
    expect(JSON.stringify(manager.get(job.jobId))).not.toContain(SECRET)
    expect(manager.submit({ ...input, sourceKey: "unsafe", material: SECRET }).status).toBe("rejected")
    expect(called).toBe(1)
  } finally { manager.dispose() }
})
