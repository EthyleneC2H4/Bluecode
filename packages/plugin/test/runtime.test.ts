import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngine, type Engine } from "@bluecode/headroomd"
import { headroomCompressParamsSchema } from "@bluecode/contracts"
import { parseOptions } from "../src/config"
import * as runtimeModule from "../src/runtime"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function messages(sessionID = "s") {
  return Array.from({ length: 7 }, (_, turn) => [
    {
      info: {
        id: `u${turn}`,
        role: "user",
        sessionID,
        time: { created: turn },
        agent: "build",
        model: { providerID: "p", modelID: "m" },
      },
      parts: [{ type: "text", text: `Keep src/auth.ts requirement ${turn}.` }],
    },
    {
      info: { id: `a${turn}`, role: "assistant", sessionID },
      parts: [
        {
          type: "text",
          text: `Verified route ${turn}.\n${"All assertions passed.\n".repeat(150)}`,
        },
      ],
    },
  ]).flat()
}
async function setup(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "blue-runtime-"))
  const engine = await createEngine({ dataDir: dir })
  cleanups.push(async () => {
    engine.close()
    await rm(dir, { recursive: true, force: true })
  })
  let requests = 0
  const headroom = {
    compress: async (p: unknown) => {
      requests++
      return engine.compress(headroomCompressParamsSchema.parse(p))
    },
    retrieve: engine.retrieve,
    getView: async (...args: Parameters<Engine["getView"]>) => engine.getView(...args),
    setView: async (...args: Parameters<Engine["setView"]>) => engine.setView(...args),
    clearView: async (...args: Parameters<Engine["clearView"]>) => engine.clearView(...args),
    close: async () => {},
  }
  const create = (runtimeModule as any).createPluginRuntime
  expect(typeof create).toBe("function")
  const runtime = create({
    projectId: "project-a",
    directory: dir,
    options: parseOptions({ headroom: { retainRecentTurns: 1 } }),
    headroom,
    rtk: null,
    ...overrides,
  })
  cleanups.push(async () => runtime.dispose())
  runtime.observeModel("s", {
    providerID: "p",
    id: "m",
    limit: { context: 6000, input: 5000, output: 1000 },
  })
  return { runtime, engine, headroom, count: () => requests, create }
}
test("ready view replays on fresh host arrays and survives plugin recreation", async () => {
  const { runtime, engine, headroom, create } = await setup()
  const raw = messages()
  await runtime.transform({ messages: structuredClone(raw) })
  await runtime.drain()
  for (let i = 0; i < 3; i++) {
    const output = { messages: structuredClone(raw) }
    await runtime.transform(output)
    expect(output.messages.length).toBeLessThan(raw.length)
    expect(output.messages[0]!.info.sessionID).toBe("s")
    expect(output.messages[0]!.info.time).toEqual({ created: 0 })
    expect(output.messages.at(-1)).toEqual(raw.at(-1))
  }
  await runtime.drain()
  expect(engine.getView({ projectId: "project-a", sessionId: "s" })).not.toBeNull()
  const reopened = create({
    projectId: "project-a",
    directory: "/tmp",
    options: parseOptions({}),
    headroom,
    rtk: null,
  })
  await reopened.transform({ messages: structuredClone(raw) })
  await reopened.drain()
  const next = { messages: structuredClone(raw) }
  await reopened.transform(next)
  expect(next.messages.length).toBeLessThan(raw.length)
  await reopened.dispose()
})
test("changed source invalidates view while appended tail remains applicable", async () => {
  const { runtime } = await setup()
  const raw = messages()
  await runtime.transform({ messages: structuredClone(raw) })
  await runtime.drain()
  const append = {
    messages: [
      ...structuredClone(raw),
      {
        info: { id: "tail", role: "user", sessionID: "s" },
        parts: [{ type: "text", text: "new requirement" }],
      },
    ],
  }
  await runtime.transform(append)
  expect(append.messages.length).toBeLessThan(raw.length)
  const edited = { messages: structuredClone(raw) }
  edited.messages[0]!.parts[0]!.text = "Changed request, must not overwrite"
  await runtime.transform(edited)
  expect(edited.messages[0]!.parts[0]!.text).toBe("Changed request, must not overwrite")
})

for (const event of [
  {
    type: "message.part.updated",
    properties: {
      part: { sessionID: "s", messageID: "u0", id: "part0", type: "text", text: "New instruction" },
    },
  },
  {
    type: "message.part.removed",
    properties: { sessionID: "s", messageID: "u0", partID: "part0" },
  },
  { type: "message.removed", properties: { sessionID: "s", messageID: "u0" } },
])
  test(`${event.type} invalidates archived memory before upstream compaction`, async () => {
    const { runtime, engine } = await setup()
    await runtime.transform({ messages: messages() })
    await runtime.drain()
    expect(engine.getView({ projectId: "project-a", sessionId: "s" })).not.toBeNull()
    await runtime.event(event)
    const output = { context: [] as string[] }
    await runtime.compacting("s", output)
    expect(output.context).toEqual([])
    await runtime.drain()
    expect(engine.getView({ projectId: "project-a", sessionId: "s" })).toBeNull()
  })

test("tail edits invalidate the planning snapshot while retaining the ready view", async () => {
  const { runtime, engine } = await setup()
  await runtime.transform({ messages: messages() })
  await runtime.drain()
  const before = engine.getView({ projectId: "project-a", sessionId: "s" })
  expect(before?.replacedMessageIds.includes("u6")).toBe(false)
  await runtime.event({
    type: "message.part.updated",
    properties: { part: { sessionID: "s", messageID: "u6", type: "text", text: "Changed tail" } },
  })
  const output = { context: [] as string[] }
  await runtime.compacting("s", output)
  expect(output.context).toEqual([])
  await runtime.drain()
  expect(engine.getView({ projectId: "project-a", sessionId: "s" })).toEqual(before)
})
test("unknown model pauses planning and model switch recomputes usable input budget", async () => {
  const { runtime, count } = await setup()
  runtime.observeModel("s", { providerID: "other", id: "unknown" })
  await runtime.transform({ messages: messages() })
  await runtime.drain()
  expect(count()).toBe(0)
  runtime.observeModel("s", {
    providerID: "other",
    id: "small",
    limit: { context: 6000, input: 5000, output: 1000 },
  })
  await runtime.transform({ messages: messages() })
  await runtime.drain()
  expect(count()).toBe(1)
})
test("shadow records plans without changing model-visible messages or tools", async () => {
  const { runtime, count } = await setup({
    options: parseOptions({ mode: "shadow", headroom: { retainRecentTurns: 1 } }),
  })
  const output = { messages: messages() },
    before = structuredClone(output)
  await runtime.transform(output)
  await runtime.drain()
  await runtime.transform(output)
  expect(count()).toBe(1)
  expect(output).toEqual(before)
})
test("MCP text blocks compress independently, images survive and retrieval bypasses RTK", async () => {
  let calls = 0
  const rtk = {
    compress: async (input: any) => {
      calls++
      return {
        kind: "compressed",
        result: {
          output: "kept",
          compressed: true,
          rawHash: "sha256:" + "a".repeat(64),
          strategy: "test",
        },
      }
    },
    shutdown: async () => {},
  }
  const { runtime } = await setup({ rtk })
  const output = {
    content: [
      { type: "text", text: "raw" },
      { type: "image", data: "xyz", mimeType: "image/png" },
    ],
  }
  await runtime.toolAfter({ tool: "mcp.logs", sessionID: "s", callID: "c", args: {} }, output)
  expect(output.content[0]!.text).toBe("kept")
  expect(output.content[1]).toEqual({ type: "image", data: "xyz", mimeType: "image/png" })
  await runtime.toolAfter(
    { tool: "headroom_retrieve", sessionID: "s", callID: "r", args: {} },
    { output: "retrieved" }
  )
  expect(calls).toBe(1)
})
test("upstream compacting pauses replay and clears only its own session", async () => {
  const { runtime } = await setup()
  const raw = messages()
  await runtime.transform({ messages: structuredClone(raw) })
  await runtime.drain()
  await runtime.compacting("s", { context: [] })
  const during = { messages: structuredClone(raw) }
  await runtime.transform(during)
  expect(during.messages).toEqual(raw)
  await runtime.event({ type: "session.compacted", properties: { sessionID: "s" } })
  const current = {
    messages: [
      { info: { id: "upstream", role: "user", sessionID: "s" }, parts: [{ type: "compaction" }] },
    ],
  }
  await runtime.transform(current)
  await runtime.drain()
  expect(current.messages[0]!.parts[0]!.type).toBe("compaction")
})
test("instances with identical session IDs remain project-isolated", async () => {
  const { runtime, headroom, create } = await setup()
  await runtime.transform({ messages: messages() })
  await runtime.drain()
  const other = create({
    projectId: "project-b",
    directory: "/tmp",
    options: parseOptions({}),
    headroom,
    rtk: null,
  })
  const output = { messages: messages() }
  await other.transform(output)
  await other.drain()
  await other.transform(output)
  expect(output.messages).toEqual(messages())
  await other.dispose()
})

test("completed tools with model-visible attachments protect their entire turn", async () => {
  const { runtime } = await setup()
  const raw: any[] = messages()
  raw[1].parts = [
    {
      type: "tool",
      tool: "read",
      callID: "read-image",
      state: {
        status: "completed",
        input: { path: "design.pdf" },
        output: "Read attachment",
        attachments: [
          { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,YQ==" },
        ],
      },
    },
  ]
  await runtime.transform({ messages: structuredClone(raw) })
  await runtime.drain()
  const next = { messages: structuredClone(raw) }
  await runtime.transform(next)
  expect(next.messages[1].parts[0].state.attachments).toEqual(raw[1].parts[0].state.attachments)
})

test("idle never republishes SDK history hidden by upstream compaction", async () => {
  let sdkReads = 0
  const { runtime, count } = await setup({
    sdk: {
      session: {
        messages: async () => {
          sdkReads++
          return { data: messages() }
        },
      },
    },
  })
  await runtime.event({ type: "session.compacted", properties: { sessionID: "s" } })
  await runtime.idle("s")
  await runtime.drain()
  const output = { context: [] }
  await runtime.compacting("s", output)
  expect(sdkReads).toBe(0)
  expect(count()).toBe(0)
  expect(output.context).toEqual([])
})

test("SDK-shaped session deletion removes its runtime state", async () => {
  const { runtime } = await setup()
  expect(runtime.stats().sessions).toBe(1)
  await runtime.event({ type: "session.deleted", properties: { info: { id: "s" } } })
  await runtime.drain()
  expect(runtime.stats().sessions).toBe(0)
})
