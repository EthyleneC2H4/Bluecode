import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { summaryProviderSchema, type ChatMessage } from "@bluecode/contracts"
import { createEngine } from "../src/engine"

function history(): ChatMessage[] {
  return Array.from({ length: 40 }, (_, i) => [
    { info: { id: `u${i}`, role: "user" as const }, parts: [{ type: "text" as const, text: "Keep the public API unchanged." }] },
    { info: { id: `a${i}`, role: "assistant" as const }, parts: [{ type: "tool" as const, tool: "read", input: { filePath: `src/${i}.ts` }, state: { status: "completed", output: Array.from({ length: 40 }, (_, line) => `export const value_${i}_${line} = ${line}`).join("\n") } }] },
  ]).flat()
}

test("background HTTP summaries return rules immediately, publish only confirmed candidates and retain budgets on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "headroom-enhancement-"))
  const gate = Promise.withResolvers<void>(), called = Promise.withResolvers<void>()
  let requests = 0
  const server = Bun.serve({ port: 0, async fetch(request) {
    requests++
    const body = await request.json() as any
    const source = JSON.parse(body.messages[1].content)
    called.resolve()
    await gate.promise
    return Response.json({ choices: [{ message: { content: JSON.stringify({ entries: [{ kind: "decisions", text: "Source files were inspected.", sourceIds: source.sourceIds }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } })
  } })
  process.env.BLUECODE_LOCAL_SUMMARY_KEY = "local-test-key"
  const summarizer = summaryProviderSchema.parse({ enabled: true, baseURL: server.url.toString(), model: "fixture", apiKeyEnv: "BLUECODE_LOCAL_SUMMARY_KEY", sessionInputTokens: 8192, sessionOutputTokens: 1024 })
  let engine = await createEngine({ dataDir: dir, summarizer })
  const ns = { projectId: "p", sessionId: "s" }
  try {
    const params = { ...ns, messages: history(), strategy: "layered" as const, contextWindowTokens: 32000, memoryMaxTokens: 400, triggerRatio: .7, retainRecentTurns: 4, epoch: "one" }
    const rule = await engine.compress(params)
    expect(rule.compacted).toBe(true)
    expect(rule.enhancementJobId).toBeString()
    await called.promise
    engine.setView(ns, rule)
    const query = { namespace: ns, jobId: rule.enhancementJobId!, epoch: "one", sourceDigests: rule.sourceSnapshot!.sourceDigests }
    expect((await engine.getCandidate(query)).status).toBe("running")
    // Neither a pending network call nor another session blocks the rule queue.
    expect((await engine.compress({ ...params, sessionId: "other", enhance: false })).compacted).toBe(true)
    expect((await engine.getCandidate({ ...query, namespace: { ...ns, sessionId: "other" } })).status).toBe("missing")
    gate.resolve()
    let result = await engine.getCandidate(query)
    for (let i = 0; i < 100 && ["queued", "running"].includes(result.status); i++) {
      await Bun.sleep(5)
      result = await engine.getCandidate(query)
    }
    expect(result.status).toBe("ready")
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 30 })
    expect(result.candidate!.finalTokensEst).toBeLessThan(rule.finalTokensEst)
    expect(engine.getView(ns)!.historyHash).toBe(rule.historyHash)
    engine.setView(ns, result.candidate!)
    engine.close()
    engine = await createEngine({ dataDir: dir, summarizer })
    expect((await engine.getCandidate(query)).candidate!.historyHash).toBe(result.candidate!.historyHash)
    expect((await engine.getCandidate(query)).usage).toEqual({ inputTokens: 100, outputTokens: 30 })
    const newRule = await engine.compress({ ...params, messages: [...params.messages, { info: { id: "next", role: "user" }, parts: [{ type: "text", text: "Continue" }] }] })
    expect(newRule.enhancementJobId).toBeUndefined()
    expect(requests).toBe(1)
    expect((await engine.getCandidate({ ...query, epoch: "changed" })).status).toBe("rejected")
  } finally {
    gate.resolve(); engine.close(); server.stop(true)
    delete process.env.BLUECODE_LOCAL_SUMMARY_KEY
    await rm(dir, { recursive: true, force: true })
  }
})
