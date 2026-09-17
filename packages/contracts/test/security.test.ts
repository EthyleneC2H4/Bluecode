import { test, expect } from "bun:test"
import * as contracts from "../src/index"

test("Security contracts export bounded input and safe result schemas", () => {
  const api = contracts as unknown as Record<string, any>
  expect(api.securityEvaluateParamsSchema).toBeDefined()
  expect(api.securitySanitizeParamsSchema).toBeDefined()
  expect(api.securityDecisionSchema).toBeDefined()
  expect(api.securitySanitizeResultSchema).toBeDefined()
})

test("Security text bounds measure UTF-8 bytes and reject oversized fields", () => {
  const api = contracts as unknown as Record<string, any>
  expect(api.securityTextSchema).toBeDefined()
  expect(api.securityTextSchema.safeParse("a".repeat(1024 * 1024)).success).toBe(true)
  expect(api.securityTextSchema.safeParse("界".repeat(400000)).success).toBe(false)
})
