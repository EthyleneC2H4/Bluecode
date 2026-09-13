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
      "--quick cannot be combined"
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
      "cannot be combined"
    )
  })
})

test("report and baseline destinations are injected through CLI flags", () => {
  expect(
    parseArgs([
      "--report-path",
      "/tmp/custom-report.json",
      "--baseline-path",
      "/tmp/custom-base.json",
    ])
  ).toMatchObject({ reportPath: "/tmp/custom-report.json", baselinePath: "/tmp/custom-base.json" })
})

test("invariants mode evaluates full data without needing a regression baseline", () => {
  expect(resolveExecution(parseArgs(["--quick", "--invariants"]))).toEqual({
    quick: false,
    action: "invariants",
  })
})

test("headroom strategy is explicit and rejects misspelled or missing values", () => {
  expect(parseArgs(["--headroom-strategy", "layered"]).headroomStrategy).toBe("layered")
  expect(parseArgs(["--headroom-strategy", "legacy"]).headroomStrategy).toBe("legacy")
  expect(parseArgs([]).headroomStrategy).toBeUndefined()
  expect(() => parseArgs(["--headroom-strategy", "layred"])).toThrow("requires legacy or layered")
  expect(() => parseArgs(["--headroom-strategy"])).toThrow("requires legacy or layered")
})

test("retained turns accepts zero and rejects invalid or missing counts", () => {
  for (const turns of [0, 1, 2, 3, 4])
    expect(parseArgs(["--retain-recent-turns", String(turns)]).retainRecentTurns).toBe(turns)
  expect(parseArgs([]).retainRecentTurns).toBeUndefined()
  for (const value of ["-1", "1.5", "NaN", "Infinity", "", "9007199254740992"])
    expect(() => parseArgs(["--retain-recent-turns", value])).toThrow("nonnegative safe integer")
  expect(() => parseArgs(["--retain-recent-turns"])).toThrow("nonnegative safe integer")
})
