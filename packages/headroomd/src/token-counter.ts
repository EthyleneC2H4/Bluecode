/** Replaceable counting boundary. The default is explicitly an estimate, never provider usage. */
import { estimateTokens } from "@bluecode/shared"
import { textDigest } from "./layered-operations"

export interface TokenCounter {
  readonly id: string
  readonly mode: "estimated" | "tokenizer"
  count(text: string): number
}
export const estimatedTokenCounter: TokenCounter = Object.freeze({
  id: "bluecode-unicode-estimate-v1",
  mode: "estimated" as const,
  count: estimateTokens,
})

/** LRU keyed by content digest; no source strings or tokenizer runtime are retained. */
export function createCachedTokenCounter(counter: TokenCounter = estimatedTokenCounter, maxEntries = 4096): TokenCounter & { readonly size: number } {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("Invalid token cache capacity")
  const values = new Map<string, number>()
  return {
    id: counter.id,
    mode: counter.mode,
    get size() { return values.size },
    count(text) {
      const key = textDigest(text)
      const previous = values.get(key)
      if (previous !== undefined) { values.delete(key); values.set(key, previous); return previous }
      const count = counter.count(text)
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("TokenCounter must return a nonnegative integer")
      values.set(key, count)
      if (values.size > maxEntries) values.delete(values.keys().next().value!)
      return count
    },
  }
}
