import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { RtkClient } from "@bluecode/rtk"
import { HeadroomClient } from "@bluecode/headroomd"
import { createPluginRuntime } from "@bluecode/plugin/runtime"
import { parseOptions } from "@bluecode/plugin/config"
import { allFixtures } from "../src/fixtures"

test("real plugin handles MCP text parts, shadow plans, durable reload and upstream invalidation", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "plugin-replay-smoke-"))
  const headroom = await HeadroomClient.connect({
    dataDir,
    timeoutMs: 10_000,
    spawn: {
      entry: path.resolve(import.meta.dir, "../../headroomd/src/bin.ts"),
      cwd: process.cwd(),
      args: ["--dataDir", dataDir, "--idleExitMs", "1000"],
    },
  })
  const rtk = await RtkClient.create({
    dataDir,
    cwd: process.cwd(),
    testMode: true,
    timeoutMs: 1000,
  })
  const make = (mode: "on" | "shadow") =>
    createPluginRuntime({
      projectId: "smoke",
      directory: process.cwd(),
      options: parseOptions({ mode }),
      rtk,
      headroom,
    })
  const runtime = make("on"),
    shadow = make("shadow")
  const source = (sessionID: string) =>
    allFixtures()
      .find((f) => f.name === "engineering-replay")!
      .messages.map((m) => ({ ...structuredClone(m), info: { ...m.info, sessionID } }))
  try {
    const lsPart = allFixtures().find((f) => f.name === "tool-ls-large")!.messages[0]!.parts[0]!
    if (lsPart.type !== "tool") throw new Error("invalid ls fixture")
    const mcp = {
      content: [
        { type: "image", data: "opaque-binary" },
        { type: "text", text: lsPart.state.output! },
      ],
    }
    const original = structuredClone(mcp)
    await runtime.toolAfter({ tool: "mcp_build", sessionID: "mcp", callID: "multi", args: {} }, mcp)
    expect(mcp.content[0]).toEqual(original.content[0])
    expect(mcp.content[1]!.text).not.toBe(original.content[1]!.text)
    expect(runtime.stats().rtkCalls).toBe(1)
    const shadowMcp = structuredClone(original)
    await shadow.toolAfter(
      { tool: "mcp_build", sessionID: "shadow-mcp", callID: "multi", args: {} },
      shadowMcp
    )
    expect(shadowMcp).toEqual(original)
    const unknown = source("unknown-model")
    await runtime.transform({ messages: unknown })
    await runtime.drain()
    expect(unknown).toEqual(source("unknown-model"))
    expect(runtime.stats().plans).toBe(0)
    for (const [instance, sessionID] of [
      [runtime, "live"],
      [shadow, "shadow"],
    ] as const) {
      instance.observeModel(sessionID, { id: "eval", limit: { context: 8192, output: 1024 } })
      const raw = source(sessionID)
      await instance.transform({ messages: structuredClone(raw) })
      await instance.drain()
      const fresh = structuredClone(raw)
      await instance.transform({ messages: fresh })
      await instance.drain()
      if (instance === shadow) {
        expect(fresh).toEqual(raw)
        expect(instance.stats().shadowPlans).toBeGreaterThan(0)
        expect(await headroom.getView({ projectId: "smoke", sessionId: sessionID })).toBeNull()
      } else {
        expect(fresh[0]!.info.id).toContain("compaction-")
        // A NEW runtime proves durable view hydration, not just an in-memory cached result.
        const restored = make("on")
        restored.observeModel(sessionID, { id: "eval", limit: { context: 8192, output: 1024 } })
        await restored.transform({ messages: structuredClone(raw) })
        await restored.drain()
        const reopened = structuredClone(raw)
        await restored.transform({ messages: reopened })
        await restored.drain()
        expect(reopened).toEqual(fresh)
        await runtime.event({ type: "session.compacted", properties: { sessionID } })
        await runtime.drain()
        expect(await headroom.getView({ projectId: "smoke", sessionId: sessionID })).toBeNull()
      }
    }
  } finally {
    await runtime.dispose()
    await shadow.dispose()
    // Explicit smoke daemon exits on idle; wait for its own pid rather than racing socket unlink.
    const { readFile } = await import("node:fs/promises")
    try {
      const pid = Number(await readFile(path.join(dataDir, "headroomd.pid"), "utf8"))
      process.kill(pid, "SIGTERM")
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0)
        } catch {
          break
        }
        await Bun.sleep(50)
      }
    } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30_000)
