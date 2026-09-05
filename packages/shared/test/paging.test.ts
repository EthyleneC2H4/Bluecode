import { describe, expect, test } from "bun:test"
import * as shared from "../src/index"

function page(text: string, options: Record<string, unknown> = {}) {
  const fn = (shared as any).paginateText
  expect(typeof fn).toBe("function")
  return fn(text, { ref: "ref-a", ...options })
}

describe("bounded content paging", () => {
  test("walks Unicode content exactly once and never splits code points", () => {
    const text = "中😀abc\n".repeat(300)
    let cursor: string | undefined
    const pieces: string[] = []
    do {
      const result = page(text, { cursor, maxBytes: 97, maxTokens: 40 })
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(97)
      expect(result.content).not.toContain("�")
      expect(result.content.length).toBeGreaterThan(0)
      pieces.push(result.content)
      expect(result.nextCursor).not.toBe(cursor)
      cursor = result.nextCursor ?? undefined
    } while (cursor)
    expect(pieces.join("")).toBe(text)
  })
  test("binds a cursor to its original reference", () => {
    const first = page("a".repeat(500), { maxBytes: 40 })
    expect(() => page("a".repeat(500), { ref: "different", cursor: first.nextCursor })).toThrow()
  })
  test("rejects malformed cursors and impossible budgets", () => {
    expect(() => page("abc", { cursor: "garbage" })).toThrow()
    expect(() => page("abc", { maxTokens: 0 })).toThrow()
    expect(() => page("😀", { maxBytes: 1 })).toThrow()
  })
  test("empty and final pages terminate", () => {
    expect(page("")).toMatchObject({ content: "", nextCursor: null, truncated: false })
    expect(page("last")).toMatchObject({ content: "last", nextCursor: null, truncated: false })
  })
  test("clamps caller limits to hard bounds", () => {
    const result = page("🙂".repeat(100000), { maxBytes: 999999, maxTokens: 999999 })
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(131072)
    expect(result.tokens).toBeLessThanOrEqual(8192)
    expect(result.truncated).toBe(true)
  })
})
