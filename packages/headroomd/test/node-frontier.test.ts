import { expect, test } from "bun:test"
import { readNodeChildren } from "../src/node-retrieval"

test("a deep node listing reads only its page frontier and resumes without omissions", () => {
  let reads = 0
  const get = (id: string) => {
    reads++
    const level = id.length - 1
    return { nodeId: id, level: 6 - level, tokens: 10, children: level < 6 ? [0, 1, 2, 3].map((n) => id + n) : [] }
  }
  let state = { stack: [{ hash: "r", offset: 0 }], ordinal: 0, intra: 0 }
  const seen = new Set<string>()
  for (;;) {
    const before = reads
    const page = readNodeChildren(get, 6, state, (children) => children.length <= 5)
    expect(reads - before).toBeLessThan(40)
    for (const child of page.children) {
      expect(seen.has(child.nodeId)).toBe(false)
      seen.add(child.nodeId)
    }
    if (!page.more) break
    state = page.state
  }
  expect(seen.size).toBe(4096)
})
