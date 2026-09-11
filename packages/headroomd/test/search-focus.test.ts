import { expect, test } from "bun:test"
import { focusSearchHit } from "../src/search-focus"

test("search cards return a bounded original excerpt around the actual matching identifier", () => {
  const raw = "unrelated setup\n".repeat(100) + "src/worker.ts: spawnHandler failed because signal was aborted\n" + "unrelated tail\n".repeat(100)
  const hit = { hash: "a".repeat(64), chunkId: "chunk", projectId: "p", sessionId: "s", score: -1, role: "assistant" as const, turnIndex: 1, snippet: raw, startOffset: 700, endOffset: 700 + raw.length }
  const focused = focusSearchHit(hit, "why spawnHandler failed", 240)
  expect(focused.snippet).toContain("spawnHandler failed because signal was aborted")
  expect(focused.snippet.length).toBeLessThanOrEqual(240)
  expect(raw.slice(focused.startOffset - 700, focused.endOffset - 700)).toBe(focused.snippet)
  expect(focused.startOffset).toBeGreaterThan(700)
})
