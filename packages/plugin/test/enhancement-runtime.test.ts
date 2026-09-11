import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngine } from "@bluecode/headroomd"
import { headroomCompressParamsSchema } from "@bluecode/contracts"
import { parseOptions } from "../src/config"
import { createPluginRuntime } from "../src/runtime"

for (const invalidate of [false, true]) test(`background candidate publication checks the latest host generation (invalidate=${invalidate})`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "blue-enhance-runtime-"))
  const released = Promise.withResolvers<void>(), called = Promise.withResolvers<void>()
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json() as any
    const ids = JSON.parse(body.messages[1].content).sourceIds
    called.resolve(); await released.promise
    return Response.json({ choices: [{ message: { content: JSON.stringify({ entries: [{ kind: "decisions", text: "Inspected source files.", sourceIds: ids }] }) } }] })
  } })
  process.env.BLUECODE_PLUGIN_SUMMARY_FIXTURE = "local-key"
  const options = parseOptions({ rtk: { mode: "off" }, headroom: { strategy: "layered", triggerRatio: .1, memoryMaxTokens: 400,
    summarizer: { enabled: true, model: "fixture", baseURL: server.url.toString(), apiKeyEnv: "BLUECODE_PLUGIN_SUMMARY_FIXTURE" } } })
  const engine = await createEngine({ dataDir: dir, summarizer: options.headroom.summarizer })
  let published = 0, requested = false
  const runtime = createPluginRuntime({ projectId: "p", directory: dir, options, rtk: null, headroom: {
    compress: async p => { requested = p.enhance === true; return engine.compress(headroomCompressParamsSchema.parse(p)) },
    retrieve: engine.retrieve, getView: async ns => engine.getView(ns), getCandidate: engine.getCandidate,
    setView: async (ns, plan) => { engine.setView(ns, plan); published++ }, clearView: async ns => engine.clearView(ns), close: async () => {},
  } })
  const messages = Array.from({ length: 40 }, (_, i) => [
    { info: { id: `u${i}`, role: "user", sessionID: "s" }, parts: [{ type: "text", text: "Keep the public API unchanged." }] },
    { info: { id: `a${i}`, role: "assistant", sessionID: "s" }, parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: `src/${i}.ts` }, output: Array.from({ length: 40 }, (_, line) => `export const value_${i}_${line} = ${line}`).join("\n") } }] },
  ]).flat()
  try {
    runtime.observeModel("s", { id: "fixture", limit: { context: 32512, output: 0 } })
    await runtime.transform({ messages: structuredClone(messages) })
    await called.promise
    // Wait for the immediate rule publication, independently of model completion.
    for (let i = 0; i < 100 && published === 0; i++) await Bun.sleep(5)
    expect(published).toBe(1)
    expect(requested).toBe(true)
    if (invalidate) await runtime.event({ type: "message.updated", properties: { info: { sessionID: "s", id: "u0" } } })
    released.resolve(); await runtime.drain()
    expect(published).toBe(invalidate ? 1 : 2)
  } finally {
    released.resolve(); await runtime.dispose(); engine.close(); server.stop(true)
    delete process.env.BLUECODE_PLUGIN_SUMMARY_FIXTURE
    await rm(dir, { recursive: true, force: true })
  }
})
