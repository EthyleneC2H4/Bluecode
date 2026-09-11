import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ChatMessage } from "@bluecode/contracts"
import { createEngine } from "../src/engine"
import { contentDigest } from "../src/turns"
import { renderProjection } from "../src/store/objects"
import { materializeCompaction } from "../src/compaction"

test("every archived source remains recoverable across 2, 5 and 20 incremental applied generations and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "headroom-generations-"))
  let engine = await createEngine({ dataDir: directory })
  const ns = { projectId: "all-evidence", sessionId: "many-generations" }
  let visible: ChatMessage[] = []
  const sources = new Map<string, string>()
  let archived = 0
  try {
    for (let generation = 1; generation <= 20; generation++) {
      for (let turn = 0; turn < 6; turn++) {
        const id = `${generation}-${turn}`
        visible.push(
          { info: { id: `u-${id}`, role: "user" }, parts: [{ type: "text", text: `Keep requirement ${id} unchanged.` }] },
          { info: { id: `a-${id}`, role: "assistant" }, parts: [{ type: "tool", tool: "read", input: { filePath: `src/file-${id}.ts` }, state: { status: "completed", output: Array.from({ length: 50 }, (_, line) => `const item_${generation}_${turn}_${line} = ${line}; // evidence ${id}`).join("\n") } }] },
        )
      }
      const plan = await engine.compress({ ...ns, messages: visible, strategy: "layered", contextWindowTokens: 20000, memoryMaxTokens: 512, retainRecentTurns: 4, triggerRatio: .7 })
      expect(plan.compacted).toBe(true)
      for (const ref of plan.refs) {
        const original = visible.find(message => contentDigest(message) === ref.contentHash)
        expect(original).toBeDefined()
        sources.set(ref.contentHash, renderProjection(original!))
      }
      archived += plan.refs.length
      const applied = materializeCompaction(visible, plan)
      expect(applied.status).toBe("applied")
      visible = applied.messages
      expect(plan.budget!.memoryTokens).toBeLessThanOrEqual(plan.budget!.historyBudgetTokens)
      if (![2, 5, 20].includes(generation)) continue
      engine.setView(ns, plan)
      engine.close()
      engine = await createEngine({ dataDir: directory })
      for (const [hash, original] of sources) {
        let cursor: string | undefined, restored = ""
        do {
          const result = await engine.retrieve({ namespace: ns, hash, maxBytes: 1500, maxTokens: 1000, ...(cursor ? { cursor } : {}) })
          if (!("content" in result)) throw Error("Archived source disappeared")
          restored += result.content
          cursor = result.nextCursor ?? undefined
        } while (cursor)
        expect(restored).toBe(original)
      }
      expect(await engine.retrieve({ namespace: { ...ns, projectId: "different" }, hash: sources.keys().next().value! })).toEqual({ found: false })
    }
    expect(sources.size).toBeGreaterThan(100)
    expect(archived).toBeGreaterThanOrEqual(sources.size)
  } finally {
    engine.close()
    await rm(directory, { recursive: true, force: true })
  }
})
