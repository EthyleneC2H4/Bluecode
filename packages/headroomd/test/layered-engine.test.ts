import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngine } from "../src/engine"
import { applyHostView, projectMessages, type HostMessage } from "../../plugin/src/host-adapter"

function history(): HostMessage[] {
  return Array.from({ length: 12 }, (_, i) => [
    { info: { id: `u${i}`, role: "user", sessionID: "s" }, parts: [{ type: "text", text: `Inspect file ${i}; do not change exported names.`, id: `text-${i}` }] },
    { info: { id: `a${i}`, role: "assistant", sessionID: "s", parentID: `u${i}`, time: { created: 1 } }, parts: [
      { type: "step-start", id: `step-${i}` },
      { type: "tool", tool: "read", callID: `read-${i}`, id: `part-${i}`, state: { status: "completed", input: { filePath: `src/${i}.ts` }, output: Array.from({ length: 100 }, (_, line) => `const value_${i}_${line} = '${i}-${line}'`).join("\n"), time: { start: 1, end: 2 }, metadata: { original: true } } },
    ] },
  ]).flat()
}

test("layered engine confirms raw evidence and replays local edits on fresh host arrays across restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "headroom-layered-engine-"))
  let engine = await createEngine({ dataDir })
  const ns = { projectId: "p", sessionId: "s" }
  const host = history()
  host[3]!.parts.push({ type: "file", url: "attachment://opaque", mime: "image/png" })
  try {
    const messages = projectMessages(host)!
    const params = { ...ns, messages, strategy: "layered" as const, contextWindowTokens: 16000, targetTokens: 8800, triggerRatio: .7, retainRecentTurns: 4 }
    const plan = await engine.compress(params)
    expect(plan.compacted).toBe(true)
    expect(plan.replacedMessageIds).not.toContain("a1")
    expect(plan.replacedMessageIds).toContain("a6")
    const evidence = await engine.retrieve({ namespace: ns, hash: plan.refs[0]!.contentHash })
    expect("found" in evidence && evidence.found).toBe(true)
    const second = await engine.compress(params)
    expect(second.metrics!.analyzedMessages).toBe(0)
    await engine.setView(ns, plan)
    engine.close()
    engine = await createEngine({ dataDir })
    const stored = engine.getView(ns)!
    const visible = structuredClone(host)
    expect(applyHostView(visible, stored)).toBe("applied")
    expect(visible[3]).toEqual(host[3])
    expect(visible[5]!.parts[0]).toEqual(host[5]!.parts[0])
    expect(visible[5]!.parts[1]!.state.metadata).toEqual({ original: true })
    expect(visible[5]!.parts[1]!.state.output).toContain("[headroom node:")
    const node = await engine.retrieve({ namespace: ns, nodeId: stored.nodes![0]!.nodeId })
    expect("node" in node && node.node.nodeId).toBe(stored.nodes![0]!.nodeId)
    expect(await engine.retrieve({ namespace: { ...ns, sessionId: "other" }, nodeId: stored.nodes![0]!.nodeId })).toEqual({ found: false })
    let cursor: string | undefined
    let restored = ""
    do {
      const page = await engine.retrieve({ namespace: ns, nodeId: stored.nodes![0]!.nodeId, detail: "source", maxBytes: 1000, maxTokens: 250, ...(cursor ? { cursor } : {}) })
      if (!("node" in page)) throw Error("Expected source page")
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1000)
      for (const item of page.sourceItems ?? []) restored += item.content
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(restored).toContain("const value_0_0 = '0-0'")
    const edited = structuredClone(host)
    edited[0]!.parts[0]!.text = "A new constraint was added"
    expect(applyHostView(edited, stored)).toBe("invalid")
    expect(edited[5]!.parts).toEqual(host[5]!.parts)
  } finally {
    engine.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
