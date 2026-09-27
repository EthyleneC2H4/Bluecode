import { test, expect } from "bun:test"
import { plannedBusinessRuns, summarizeBusinessRuns } from "../src/business-experiment"

test("Frozen business matrix has twelve natural and four pressure runs in AB/BA order", () => {
  const plan = plannedBusinessRuns()
  expect(plan.length).toBe(16)
  expect(plan.filter(run => run.kind === "natural").length).toBe(12)
  expect(plan.filter(run => run.kind === "pressure").length).toBe(4)
  expect(plan.filter(run => run.repeat === 0).slice(0, 2).map(run => run.arm)).toEqual(["baseline", "combo"])
  expect(plan.filter(run => run.repeat === 1).slice(0, 2).map(run => run.arm)).toEqual(["combo", "baseline"])
  expect(new Set(plan.map(run => run.id)).size).toBe(16)
})

test("Summary preserves failures and separates pressure from natural tasks", () => {
  const plan = plannedBusinessRuns()
  const records = plan.map((run, index) => ({ ...run, passed: index === 0, durationMs: 100, actualInput: index === 0 ? 10 : null,
    actualOutput: index === 0 ? 2 : null, compressionExercised: false, failureType: index === 0 ? null : "business_error" }))
  const summary = summarizeBusinessRuns(records)
  expect(summary.natural.requested).toBe(12)
  expect(summary.pressure.requested).toBe(4)
  expect(summary.natural.passed).toBe(1)
  expect(summary.pressure.passed).toBe(0)
  expect(summary.natural.actualInput).toBeNull()
  expect(summary.pressure.actualInput).toBeNull()
  expect(summary.natural.failures.business_error).toBe(11)
  expect(summary.natural.byArm.baseline.actualInput).toBeNull()
  expect(summary.natural.byArm.combo.durationMs).toBe(600)
})

test("Summary keeps provider usage separate for each arm", () => {
  const records = plannedBusinessRuns().map(run => ({ ...run, passed: true, durationMs: run.arm === "combo" ? 200 : 100,
    actualInput: run.arm === "combo" ? 20 : 10, actualOutput: run.arm === "combo" ? 4 : 2,
    compressionExercised: run.arm === "combo", failureType: null }))
  const summary = summarizeBusinessRuns(records)
  expect(summary.natural.byArm.baseline).toMatchObject({ requested: 6, completed: 6, passed: 6, actualInput: 60, actualOutput: 12, durationMs: 600 })
  expect(summary.natural.byArm.combo).toMatchObject({ requested: 6, completed: 6, passed: 6, actualInput: 120, actualOutput: 24, durationMs: 1200 })
  expect(summary.pressure.byArm.baseline.actualInput).toBe(20)
  expect(summary.pressure.byArm.combo.actualInput).toBe(40)
})
