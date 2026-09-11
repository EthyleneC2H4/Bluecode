import { expect, test } from "bun:test"
import { parseOptions } from "../src/config"

test("layered memory is configurable and enhancement requires an explicit provider", () => {
  const defaults = parseOptions({})
  expect(defaults.headroom.strategy).toBe("legacy")
  expect(defaults.headroom.memoryMaxTokens).toBe(4096)
  expect(defaults.headroom.summarizer.enabled).toBe(false)
  expect(() => parseOptions({ headroom: { summarizer: { enabled: true } } })).toThrow()
  const parsed = parseOptions({ headroom: { strategy: "layered", memoryMaxTokens: 2048,
    summarizer: { enabled: true, baseURL: "https://opencode.ai/zen/v1", model: "mimo-v2.5-free", apiKeyEnv: "OPENCODE_ZEN_API_KEY" },
  } })
  expect(parsed.headroom.memoryMaxTokens).toBe(2048)
  expect(parsed.headroom.summarizer.maxInputTokens).toBe(8192)
  expect(parsed.headroom.summarizer.sessionOutputTokens).toBe(4096)
  expect(() => parseOptions({ headroom: { memoryRatio: 2 } })).toThrow()
  expect(() => parseOptions({ headroom: { summarizer: { apiKey: "secret" } } })).toThrow()
})
