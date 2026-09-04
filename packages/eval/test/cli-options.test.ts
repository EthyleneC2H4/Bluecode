import { describe, expect, test } from "bun:test"
import { parseArgs, resolveExecution } from "../src/cli"

describe("eval CLI execution mode", () => {
  test("--check forces a fresh full evaluation even when --quick is also present", () => {
    expect(resolveExecution(parseArgs(["--quick", "--check"]))).toEqual({
      quick: false,
      action: "check",
    })
  })

  test("--update-baseline always means full and rejects quick mode", () => {
    expect(resolveExecution(parseArgs(["--update-baseline"]))).toEqual({
      quick: false,
      action: "update-baseline",
    })
    expect(() => resolveExecution(parseArgs(["--quick", "--update-baseline"]))).toThrow(
      "--quick cannot be combined",
    )
  })

  test("plain --quick remains a quick report run", () => {
    expect(resolveExecution(parseArgs(["--quick"]))).toEqual({
      quick: true,
      action: "report",
    })
  })
})
