import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngine, type Engine } from "@bluecode/headroomd"
import { headroomCompressParamsSchema, summaryProviderSchema } from "@bluecode/contracts"
import { createPluginRuntime, type HeadroomPort } from "../src/runtime"
import { parseOptions } from "../src/config"
import { applyHostView, projectMessages, type HostMessage } from "../src/host-adapter"

const ns = { projectId: "p", sessionId: "s" }
function source(verbose = false): HostMessage[] {
  return Array.from({ length: 40 }, (_, i) => [
    { info: { id: `u${i}`, role: "user", sessionID: "s" }, parts: [{ type: "text", text: "Keep the public API unchanged." }] },
    { info: { id: `a${i}`, role: "assistant", sessionID: "s" }, parts: [...(verbose ? [{ type: "text", text: "Routine progress. " + "Repeated context. ".repeat(200) }] : []), { type: "tool", tool: "read", state: { status: "completed", input: { filePath: `src/${i}.ts` }, output: Array.from({ length: 40 }, (_, line) => `export const value_${i}_${line} = ${line}`).join("\n") } }] },
  ]).flat()
}
const params = (raw: HostMessage[], strategy: "legacy" | "layered") => headroomCompressParamsSchema.parse({ ...ns, messages: projectMessages(raw), strategy, contextWindowTokens: 32000, targetTokens: 10000, memoryMaxTokens: 400, triggerRatio: .1, retainRecentTurns: 4, epoch: "", enhance: false })
function port(engine: Engine): HeadroomPort {
  return { compress: p => engine.compress(headroomCompressParamsSchema.parse(p)), retrieve: engine.retrieve, getView: async n => engine.getView(n), setView: async (n, p) => engine.setView(n, p), clearView: async n => engine.clearView(n), close: async () => {} }
}

for (const [savedTurns, configuredTurns, compatible] of [[0, 1, false], [1, 4, false], [4, 1, true], [0, 0, true]] as const) {
  test(`restart enforces ${configuredTurns} retained turns on a persisted ${savedTurns}-turn view below the trigger`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "blue-retention-hydrate-")), raw = source(), engine = await createEngine({ dataDir: dir })
    let runtime: ReturnType<typeof createPluginRuntime> | undefined
    try {
      const plan = await engine.compress({ ...params(raw, "layered"), retainRecentTurns: savedTurns })
      expect(plan.compacted).toBe(true)
      engine.setView(ns, plan)
      runtime = createPluginRuntime({ projectId: "p", directory: dir, rtk: null, headroom: port(engine),
        options: parseOptions({ headroom: { strategy: "layered", retainRecentTurns: configuredTurns } }) })
      runtime.observeModel("s", { id: "fixture", limit: { context: 1e9, output: 0 } })
      await runtime.transform({ messages: structuredClone(raw) }); await runtime.drain()
      const expected = structuredClone(raw)
      if (compatible) expect(applyHostView(expected, plan)).toBe("applied")
      const output = { messages: structuredClone(raw) }
      await runtime.transform(output); await runtime.drain()
      expect(output.messages).toEqual(expected)
      expect(output.messages.slice(-2 * (configuredTurns + 1))).toEqual(raw.slice(-2 * (configuredTurns + 1)))
      expect(runtime.stats().plans).toBe(0)
      if (!compatible) {
        expect(engine.getView(ns)).toBeNull()
        expect(await engine.retrieve({ namespace: ns, hash: plan.refs[0]!.contentHash })).toMatchObject({ found: true })
      }
    } finally { await runtime?.dispose(); engine.close(); await rm(dir, { recursive: true, force: true }) }
  })
}
for (const [saved, configured] of [["layered", "legacy"], ["legacy", "layered"], ["legacy", "legacy"], ["layered", "layered"]] as const) {
  test(`restart restores only compatible ${saved} view under ${configured}, even below trigger`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "blue-hydrate-")), raw = source(true)
    let engine = await createEngine({ dataDir: dir })
    let runtime: ReturnType<typeof createPluginRuntime> | undefined
    try {
      const plan = await engine.compress(params(raw, saved))
      expect(plan.compacted).toBe(true)
      if (saved === "legacy") expect(plan.strategy).toBeUndefined()
      engine.setView(ns, plan); engine.close(); engine = await createEngine({ dataDir: dir })
      runtime = createPluginRuntime({ projectId: "p", directory: dir, rtk: null, headroom: port(engine), options: parseOptions({ headroom: { strategy: configured } }) })
      runtime.observeModel("s", { id: "fixture", limit: { context: 1e9, output: 0 } })
      await runtime.transform({ messages: structuredClone(raw) }); await runtime.drain()
      const expected = structuredClone(raw)
      if (saved === configured) expect(applyHostView(expected, plan)).toBe("applied")
      for (let repeat = 0; repeat < 3; repeat++) {
        const output = { messages: structuredClone(raw) }
        await runtime.transform(output); await runtime.drain()
        expect(output.messages).toEqual(expected)
      }
      expect(runtime.stats().plans).toBe(0)
      if (saved !== configured) {
        expect(engine.getView(ns)).toBeNull()
        expect(await engine.retrieve({ namespace: ns, hash: plan.refs[0]!.contentHash })).toMatchObject({ found: true })
      }
    } finally { await runtime?.dispose(); engine.close(); await rm(dir, { recursive: true, force: true }) }
  })
}

test("incompatible active view is cleared before current-strategy planning can read its nodes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blue-hydrate-order-")), raw = source(true), engine = await createEngine({ dataDir: dir })
  const order: string[] = []
  const backend = port(engine)
  let runtime: ReturnType<typeof createPluginRuntime> | undefined
  try {
    engine.setView(ns, await engine.compress(params(raw, "layered")))
    runtime = createPluginRuntime({ projectId: "p", directory: dir, rtk: null, options: parseOptions({ headroom: { strategy: "legacy" } }), headroom: {
      ...backend,
      getView: async n => { await Bun.sleep(20); return engine.getView(n) },
      clearView: async n => { order.push("clear"); engine.clearView(n) },
      compress: async p => { order.push("compress"); expect(engine.getView(ns)).toBeNull(); expect(p.strategy).toBe("legacy"); return backend.compress(p) },
    } })
    runtime.observeModel("s", { id: "fixture", limit: { context: 6000, output: 0 } })
    await runtime.transform({ messages: structuredClone(raw) }); await runtime.drain()
    expect(order).toEqual(["clear", "compress"])
    expect(runtime.stats().plans).toBe(1)
    expect(engine.getView(ns)?.strategy ?? "legacy").toBe("legacy")
  } finally { await runtime?.dispose(); engine.close(); await rm(dir, { recursive: true, force: true }) }
})

test("persisted enhanced views rebuild when summarizer is disabled, changed, or unprovable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blue-hydrate-enhanced-")), raw = source()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any, source = JSON.parse(body.messages[1].content)
    return Response.json({ choices: [{ message: { content: JSON.stringify({ entries: [{ kind: "decisions", text: "Source files inspected.", sourceIds: source.sourceIds }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } })
  } })
  const env = "BLUECODE_HYDRATE_LOCAL_FIXTURE_KEY"
  process.env[env] = "local-fixture-placeholder"
  const summarizer = summaryProviderSchema.parse({ enabled: true, baseURL: server.url.toString(), model: "fixture", apiKeyEnv: env })
  let engine = await createEngine({ dataDir: dir, summarizer })
  try {
    const rule = await engine.compress({ ...params(raw, "layered"), enhance: true, summaryProvider: summarizer })
    expect(rule.enhancementJobId).toBeString()
    const query = { namespace: ns, jobId: rule.enhancementJobId!, epoch: "", sourceDigests: rule.sourceSnapshot!.sourceDigests }
    let result = await engine.getCandidate(query)
    for (let i = 0; i < 100 && ["queued", "running"].includes(result.status); i++) { await Bun.sleep(5); result = await engine.getCandidate(query) }
    expect(result.status).toBe("ready")
    const enhanced = result.candidate!
    expect(enhanced.nodes?.some(node => node.policyVersion.startsWith("layered-summary-"))).toBe(true)
    engine.setView(ns, enhanced); engine.close(); engine = await createEngine({ dataDir: dir, summarizer })
    for (const selected of [{ enabled: false }, { ...summarizer, model: "changed" }, { ...summarizer, baseURL: server.url.toString() + "other" }, summarizer]) {
      engine.setView(ns, enhanced)
      const runtime = createPluginRuntime({ projectId: "p", directory: dir, rtk: null, headroom: port(engine), options: parseOptions({ headroom: { strategy: "layered", summarizer: selected } }) })
      try {
        runtime.observeModel("s", { id: "fixture", limit: { context: 1e9, output: 0 } })
        await runtime.transform({ messages: structuredClone(raw) }); await runtime.drain()
        const output = { messages: structuredClone(raw) }
        await runtime.transform(output); await runtime.drain()
        expect(output.messages).toEqual(raw)
        expect(engine.getView(ns)).toBeNull()
        expect(await engine.retrieve({ namespace: ns, hash: enhanced.refs[0]!.contentHash })).toMatchObject({ found: true })
      } finally { await runtime.dispose() }
    }
  } finally { engine.close(); server.stop(true); delete process.env[env]; await rm(dir, { recursive: true, force: true }) }
})
