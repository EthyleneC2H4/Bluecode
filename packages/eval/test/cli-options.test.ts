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

  test("unknown arguments are rejected instead of becoming successful help", () => {
    expect(() => parseArgs(["--chek"])).toThrow("Unknown argument: --chek")
  })

  test("--check and --update-baseline are mutually exclusive", () => {
    expect(() => resolveExecution(parseArgs(["--check", "--update-baseline"]))).toThrow(
      "cannot be combined",
    )
  })
})
