import { expect, test } from "bun:test"
import * as pages from "../src/query-pages"

const hit = (id: number, startOffset: number, snippet: string) => ({
  hash: `hash-${id}`,
  chunkId: `chunk-${id}`,
  startOffset,
  endOffset: startOffset + snippet.length,
  snippet,
})

test("the fifth ranked hit is counted once and its continuation is read to completion", async () => {
  expect(pages.collectQueryHits).toBeFunction()
  const responses = [
    {
      hits: [
        hit(1, 0, "one"),
        hit(2, 0, "two"),
        hit(3, 0, "three"),
        hit(4, 0, "four"),
        hit(5, 100, "first-"),
      ],
      nextCursor: "page2",
    },
    { hits: [hit(5, 106, "second-")], nextCursor: "page3" },
    { hits: [hit(5, 113, "last-answer")], nextCursor: null },
  ]
  const cursors: Array<string | undefined> = []
  const results = await pages.collectQueryHits(async (cursor) => {
    cursors.push(cursor)
    return responses[cursors.length - 1]!
  })
  expect(cursors).toEqual([undefined, "page2", "page3"])
  expect(results).toHaveLength(5)
  expect(results[4]).toEqual(hit(5, 100, "first-second-last-answer"))
})

test("a gap in a continuation is rejected rather than inventing contiguous evidence", async () => {
  let calls = 0
  await expect(
    pages.collectQueryHits(async () =>
      ++calls === 1
        ? { hits: [hit(1, 0, "abc")], nextCursor: "next" }
        : { hits: [hit(1, 5, "def")], nextCursor: null }
    )
  ).rejects.toThrow("non-contiguous")
})
