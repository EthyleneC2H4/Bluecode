import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngine } from "../src/engine"
import type { ChatMessage } from "@bluecode/contracts"

test("frontier cursors survive daemon restart and cannot cross sessions or archives", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "headroom-frontier-"))
  let engine = await createEngine({ dataDir })
  const ns = { projectId: "project", sessionId: "session" }
  const messages: ChatMessage[] = Array.from({ length: 4 }, (_, i) => [
    { info: { id: `u${i}`, role: "user" as const }, parts: [{ type: "text" as const, text: `requirement ${i}` }] },
    { info: { id: `a${i}`, role: "assistant" as const }, parts: [{ type: "text" as const, text: "repeated observation\n".repeat(500) }] },
  ]).flat()
  try {
    const plan = await engine.compress({ ...ns, messages, contextWindowTokens: 10000, targetTokens: 0, triggerRatio: .7, retainRecentTurns: 0 })
    const first = await engine.retrieve({ namespace: ns, historyHash: plan.historyHash!, maxBytes: 100, maxTokens: 100 })
    if (!("items" in first) || !first.nextCursor) throw Error("Expected paginated archive")
    expect(first.nextCursor.startsWith("h3-")).toBe(true)
    engine.close()
    engine = await createEngine({ dataDir })
    const second = await engine.retrieve({ namespace: ns, historyHash: plan.historyHash!, cursor: first.nextCursor, maxBytes: 100, maxTokens: 100 })
    expect("items" in second && second.items.length).toBeGreaterThan(0)
    const foreign = { ...ns, sessionId: "foreign" }
    const other = await engine.compress({ ...foreign, messages, contextWindowTokens: 10000, targetTokens: 0, triggerRatio: .7, retainRecentTurns: 0 })
    await expect(engine.retrieve({ namespace: foreign, historyHash: other.historyHash!, cursor: first.nextCursor })).rejects.toThrow(/reference/)
  } finally {
    engine.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
