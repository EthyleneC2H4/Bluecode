import { expect, test } from "bun:test"
import { readHistoryPage, type HistoryReader } from "../src/history-reader"

test("resumed history pages visit only the saved frontier and preserve every character", async () => {
  let reads = 0
  const reader: HistoryReader = {
    row: async (hash, offset) => {
      reads++
      if (offset >= 200) return null
      return { hash: `${hash}:${offset}`, role: "assistant", turnIndex: offset }
    },
    content: async (row) => ({ text: `evidence ${row.hash}\n` }),
  }
  let state = { stack: [{ hash: "root", offset: 0 }], ordinal: 0, intra: 0 }
  let content = "", previous = 0, pages = 0
  for (;;) {
    const page = await readHistoryPage(reader, state, { maxBytes: 24, maxTokens: 24, limit: 3 })
    expect(reads - previous).toBeLessThanOrEqual(5)
    previous = reads
    content += page.items.map((item) => item.content).join("")
    pages++
    if (!page.more) break
    state = structuredClone(page.state)
  }
  expect(pages).toBeGreaterThan(100)
  expect(content).toBe(Array.from({ length: 200 }, (_, i) => `evidence root:${i}\n`).join(""))
})

test("history frontier resumes within a child and advances past missing objects", async () => {
  const rows: Record<string, string[]> = { root: ["a", "child-ref", "missing", "z"], child: ["b", "c"] }
  const reader: HistoryReader = {
    row: async (hash, offset) => rows[hash]?.[offset] ? { hash: rows[hash]![offset]!, role: "user", turnIndex: offset } : null,
    content: async ({ hash }) => hash === "missing" ? null : hash === "child-ref" ? { child: "child" } : { text: hash.repeat(8) },
  }
  let state = { stack: [{ hash: "root", offset: 0 }], ordinal: 0, intra: 0 }
  const missing: string[] = []
  let text = ""
  for (;;) {
    const page = await readHistoryPage(reader, state, { maxBytes: 5, maxTokens: 5, limit: 10 })
    text += page.items.map((item) => item.content).join("")
    missing.push(...page.missingHashes)
    if (!page.more) break
    state = page.state
  }
  expect(text).toBe("a".repeat(8) + "b".repeat(8) + "c".repeat(8) + "z".repeat(8))
  expect(missing).toEqual(["missing"])
})

test("history frontier advances using indexed sequence keys across gaps", async () => {
  const visited: number[] = []
  const reader: HistoryReader = {
    row: async (_hash, sequence) => {
      visited.push(sequence)
      const key = [100, 900].find((key) => key >= sequence)
      return key === undefined ? null : { hash: String(key), role: "user", turnIndex: 0, nextOffset: key + 1 }
    },
    content: async (row) => ({ text: row.hash }),
  }
  const page = await readHistoryPage(reader, { stack: [{ hash: "root", offset: 0 }], ordinal: 0, intra: 0 }, { maxBytes: 100, maxTokens: 100, limit: 3 })
  expect(page.items.map((item) => item.content)).toEqual(["100", "900"])
  expect(visited).toEqual([0, 101, 901])
})
