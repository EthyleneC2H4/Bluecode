import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngine } from "../../rtk/src/engine"
import { createPluginRuntime } from "../src/runtime"
import { createRetrieveTool } from "../src/retrieval"
import { parseOptions } from "../src/config"
import { RtkClient } from "@bluecode/rtk"

test("layered retrieval respects RTK wire token limits when the outer byte budget is larger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retrieval-layered-wire-"))
  const rtk = await RtkClient.create({ dataDir: dir, timeoutMs: 2000 })
  const runtime = createPluginRuntime({
    projectId: "p", directory: dir,
    options: parseOptions({ headroom: { strategy: "layered" } }),
    headroom: null, rtk,
  })
  try {
    const original = 'row "quoted" \\ 中文🙂\n'.repeat(2000)
    const stored = await rtk.compress({ tool: "unknown", output: original, sessionId: JSON.stringify(["p", "s"]) })
    expect(stored.result).toBeDefined()
    const retrieve = createRetrieveTool(runtime)
    let cursor: string | undefined, recovered = "", pages = 0
    do {
      const result = await retrieve.execute({ hash: stored.result!.rawHash, maxTokens: 8192, maxBytes: 32768, ...(cursor ? { cursor } : {}) }, { sessionID: "s", metadata: () => {} } as any)
      expect(typeof result).toBe("object")
      if (typeof result === "string") throw new Error(result)
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32768)
      const page = JSON.parse(result.output)
      expect(page.kind).toBe("found")
      expect(page.content.length).toBeGreaterThan(0)
      recovered += page.content
      expect(page.nextCursor).not.toBe(cursor)
      cursor = page.nextCursor ?? undefined
      expect(++pages).toBeLessThan(100)
    } while (cursor)
    expect(pages).toBeGreaterThan(1)
    expect(recovered).toBe(original)
  } finally {
    await runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("production retrieval budgets the envelope and reassembles escaped unicode without recompression", async () => {
  const dir = await mkdtemp(join(tmpdir(), "retrieval-tool-"))
  const engine = createEngine({ dataDir: dir })
  const namespace = JSON.stringify(["p", "s"])
  const original = 'path: "src/auth.ts" \\ line\n中文🙂\n'.repeat(120)
  const stored = await engine.compress({ tool: "unknown", output: original, sessionId: namespace })
  let compressions = 0
  const runtime = createPluginRuntime({
    projectId: "p",
    directory: dir,
    options: parseOptions({}),
    headroom: null,
    rtk: {
      compress: async () => {
        compressions++
        throw new Error("retrieval was recompressed")
      },
      fetch: async (params) => {
        const result = await engine.fetch(params)
        return result.found
          ? {
              kind: "found",
              content: result.content,
              nextCursor: result.nextCursor,
              truncated: result.truncated,
            }
          : { kind: "missing" }
      },
      shutdown: async () => {},
    },
  })
  const retrieve = createRetrieveTool(runtime)
  const context = { sessionID: "s", metadata: () => {} } as any
  try {
    let cursor: string | undefined,
      recovered = ""
    do {
      const result = await retrieve.execute(
        { hash: stored.rawHash, maxTokens: 2048, maxBytes: 1200, ...(cursor ? { cursor } : {}) },
        context
      )
      if (typeof result === "string") throw new Error(result)
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1200)
      const page = JSON.parse(result.output)
      expect(page.content.length).toBeGreaterThan(0)
      recovered += page.content
      expect(page.nextCursor).not.toBe(cursor)
      cursor = page.nextCursor ?? undefined
      await runtime.toolAfter(
        { tool: "headroom_retrieve", sessionID: "s", callID: "r", args: {} },
        result
      )
    } while (cursor)
    expect(recovered).toBe(original)
    expect(compressions).toBe(0)
    const foreign = await retrieve.execute(
      { hash: stored.rawHash },
      { ...context, sessionID: "other" }
    )
    expect(typeof foreign === "object" && JSON.parse(foreign.output).kind).toBe("missing")
  } finally {
    await runtime.dispose()
    engine.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("unavailable retrieval errors obey the same UTF8 output budget", async () => {
  const runtime = createPluginRuntime({
    projectId: "p",
    directory: "/tmp",
    options: parseOptions({}),
    rtk: null,
    headroom: null,
  })
  const retrieve = createRetrieveTool(runtime)
  for (const args of [{ hash: "sha256:" + "a".repeat(64) }, { query: "history" }]) {
    const output = await retrieve.execute({ ...args, maxBytes: 1, maxTokens: 1 }, {
      sessionID: "s",
      metadata: () => {},
    } as any)
    expect(typeof output).toBe("string")
    expect(Buffer.byteLength(output as string)).toBeLessThanOrEqual(1)
  }
  await runtime.dispose()
})
