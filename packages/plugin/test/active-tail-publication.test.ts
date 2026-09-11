import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngine } from "@bluecode/headroomd"
import { headroomCompressParamsSchema, type HeadroomCompressResult } from "@bluecode/contracts"
import { parseOptions } from "../src/config"
import { createPluginRuntime } from "../src/runtime"
import { applyHostView, projectMessages, type HostMessage } from "../src/host-adapter"

const model = { id: "fixture", providerID: "local", limit: { context: 20000, output: 1000 } }
function source(): HostMessage[] {
  return Array.from({ length: 5 }, (_, i) => [
    { info: { id: `u${i}`, role: "user", sessionID: "s" }, parts: [{ type: "text", text: `Keep requirement ${i}.` }] },
    { info: { id: `a${i}`, role: "assistant", sessionID: "s" }, parts: [
      { type: "text", text: "Current progress." },
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: `src/${i}.ts` }, output: "original evidence line\n".repeat(1000) } },
    ] },
  ]).flat()
}

for (const change of ["tail-event", "tail-transform", "same-model", "model-limit", "current-user", "protected-island"] as const) {
  test(`delayed real engine publication handles ${change}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "blue-active-tail-"))
    const engine = await createEngine({ dataDir: dir })
    const called = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let plan: HeadroomCompressResult | undefined, published = 0
    const runtime = createPluginRuntime({ projectId: "p", directory: dir, rtk: null,
      options: parseOptions({ rtk: { mode: "off" }, headroom: { strategy: "layered", triggerRatio: .1, retainRecentTurns: 0 } }),
      headroom: {
        compress: async params => { plan = await engine.compress(headroomCompressParamsSchema.parse(params)); called.resolve(); await release.promise; return plan },
        retrieve: engine.retrieve, getView: async ns => engine.getView(ns),
        setView: async (ns, value) => { engine.setView(ns, value); published++ },
        clearView: async ns => engine.clearView(ns), close: async () => {},
      },
    })
    const messages = source()
    messages[3]!.parts.push({ type: "reasoning", text: "Opaque protected island." })
    try {
      runtime.observeModel("s", model)
      await runtime.transform({ messages: structuredClone(messages) })
      await called.promise
      expect(plan?.compacted).toBe(true)
      if (change === "same-model") runtime.observeModel("s", structuredClone(model))
      else if (change === "model-limit") runtime.observeModel("s", { ...model, limit: { context: 18000, output: 1000 } })
      else {
        const index = change === "current-user" ? 8 : change === "protected-island" ? 3 : 9
        messages[index]!.parts[0]!.text = "Latest streamed text or edited requirement."
        messages[index]!.parts.push({ type: "tool", tool: "bash", state: { status: "running", input: { command: "test" } } })
        if (change !== "tail-transform") await runtime.event({ type: "message.part.updated", properties: { part: { sessionID: "s", messageID: messages[index]!.info.id } } })
        await runtime.transform({ messages: structuredClone(messages) })
      }
      release.resolve(); await runtime.drain()
      const invalid = ["model-limit", "current-user", "protected-island"].includes(change)
      expect(published).toBe(invalid ? 0 : 1)
      if (!invalid) {
        expect(engine.getView({ projectId: "p", sessionId: "s" })).not.toBeNull()
        for (let i = 0; i < 3; i++) {
          const output = { messages: structuredClone(messages) }
          await runtime.transform(output)
          expect(JSON.stringify(output.messages)).toContain("[headroom node:")
          expect(output.messages.at(-1)).toEqual(messages.at(-1))
          expect(output.messages.find(m => m.info.id === "u4")).toEqual(messages[8])
        }
        await runtime.drain()
        // An edit event must clear a ready view even before a fresh transform,
        // including a protected historical island that no operation replaces.
        await runtime.event({ type: "message.updated", properties: { info: { sessionID: "s", id: "a1" } } })
        const fallback = { context: [] as string[] }
        await runtime.compacting("s", fallback)
        expect(fallback.context).toEqual([])
        await runtime.drain()
        expect(engine.getView({ projectId: "p", sessionId: "s" })).toBeNull()
      }
    } finally {
      release.resolve(); await runtime.dispose(); engine.close(); await rm(dir, { recursive: true, force: true })
    }
  })
}

test("layered snapshot binds all history through current user while budget counts active tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blue-tail-digest-"))
  const engine = await createEngine({ dataDir: dir })
  try {
    const messages = source()
    const params = headroomCompressParamsSchema.parse({ projectId: "p", sessionId: "s", messages: projectMessages(messages), strategy: "layered", contextWindowTokens: 20000, targetTokens: 1000, retainRecentTurns: 0 })
    const plan = await engine.compress(params)
    expect(plan.sourceSnapshot?.messageIds).toEqual(messages.slice(0, 9).map(m => m.info.id))
    const withoutTail = await engine.compress({ ...params, messages: params.messages.slice(0, -1) })
    expect(plan.rawTokens).toBeGreaterThan(withoutTail.rawTokens)
    expect(plan.budget!.recentTokens).toBeGreaterThan(withoutTail.budget!.recentTokens)
    for (const index of [0, 3, 8]) {
      const edited = structuredClone(messages)
      edited[index]!.parts[0]!.text += " edited"
      expect(applyHostView(edited, plan)).toBe("invalid")
    }
    const reordered = structuredClone(messages)
    ;[reordered[2], reordered[3]] = [reordered[3]!, reordered[2]!]
    expect(applyHostView(reordered, plan)).toBe("invalid")
    const deleted = structuredClone(messages); deleted.splice(3, 1)
    expect(applyHostView(deleted, plan)).toBe("invalid")
  } finally { engine.close(); await rm(dir, { recursive: true, force: true }) }
})
