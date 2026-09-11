import { expect, test } from "bun:test"
import { createCachedTokenCounter } from "../src/token-counter"

test("content-digest token caching reuses counts and evicts least recently used entries", () => {
  let counts = 0
  const counter = createCachedTokenCounter({ id: "test-character-counter", mode: "tokenizer", count: (text) => { counts++; return [...text].length } }, 2)
  expect(counter.count("相同A")).toBe(3)
  expect(counter.count("相同A")).toBe(3)
  expect(counts).toBe(1)
  counter.count("B")
  counter.count("相同A")
  counter.count("C")
  expect(counter.size).toBe(2)
  counter.count("B")
  expect(counts).toBe(4)
  expect(counter.mode).toBe("tokenizer")
})

test("invalid tokenizer results fail without poisoning the digest cache", () => {
  const counter = createCachedTokenCounter({ id: "bad", mode: "tokenizer", count: () => Number.NaN })
  expect(() => counter.count("text")).toThrow(/nonnegative integer/)
  expect(counter.size).toBe(0)
  expect(() => createCachedTokenCounter(undefined, 0)).toThrow(/capacity/)
})
