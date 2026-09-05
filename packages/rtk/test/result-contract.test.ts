import { expect, test } from "bun:test"
import { compressResultSchema } from "@bluecode/contracts"
import { compressToolOutput } from "@bluecode/rtk-core"
import { lsLaOutput } from "./helpers"
test("v3 schema rejects false compressed claims and inconsistent accounting", async () => {
  const result = await compressToolOutput({ tool: "ls", output: lsLaOutput(100) })
  expect(compressResultSchema.safeParse(result).success).toBe(true)
  expect(compressResultSchema.safeParse({ ...result, compressed: false }).success).toBe(false)
  expect(
    compressResultSchema.safeParse({ ...result, actualTokens: result.actualTokens + 1 }).success
  ).toBe(false)
  expect(
    compressResultSchema.safeParse({ ...result, budgetExceeded: !result.budgetExceeded }).success
  ).toBe(false)
  expect(
    compressResultSchema.safeParse({ ...result, omittedRanges: [{ startLine: 10, endLine: 2 }] })
      .success
  ).toBe(false)
})
