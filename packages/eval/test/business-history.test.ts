import { test, expect } from "bun:test"
import { seedBusinessHistory } from "../src/business-history"

test("Pressure seed keeps the refund contract and complete long tool turns", () => {
  const seed = seedBusinessHistory("/workspace", "ses_test")
  expect(seed.messages.length).toBe(28)
  expect(seed.messages[0]?.parts[0]?.text).toContain("累计退款")
  expect(seed.messages.filter((message: any) => message.info.role === "assistant").every((message: any) => message.parts[0].state.status === "completed")).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(seed))).toBeGreaterThan(100000)
  expect(Buffer.byteLength(JSON.stringify(seed))).toBeLessThan(140000)
})
