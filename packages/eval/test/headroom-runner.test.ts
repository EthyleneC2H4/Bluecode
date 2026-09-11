import { expect, spyOn, test } from "bun:test"
import { HeadroomClient } from "@bluecode/headroomd"
import { existsSync } from "node:fs"
import { makeHeadroomFixture } from "../src/headroom-fixtures"
import { runHeadroomEvaluation } from "../src/headroom-runner"

test("Production replay preserves native safety islands and constraints while compressing later evidence", async () => {
  const result = await runHeadroomEvaluation({ fixtures: [makeHeadroomFixture("protected-islands", 50)], replaySteps: 3 })
  const row = result.comparisons[0]!.layered
  expect(row.runtime.applied).toBeGreaterThan(0)
  expect(row.quality.protectedMessagesIntact).toBe(true)
  expect(row.quality.constraintsFound).toBe(row.quality.constraintsTotal)
  expect(row.operations.analyzedMessages).toBeLessThan(row.operations.scannedMessages!)
  expect(row.operations.analysisCacheHits).toBeGreaterThan(0)
  expect(row.daemon.rssPeakBytes).toBeGreaterThan(0)
  expect(row.calls.filter((c) => c.phase === "host")).toHaveLength(6)
  expect(row.cumulativeInputTokens).toBe(row.calls.reduce((n, c) => n + c.inputTokens, 0))
  expect(row.quality.sourceRecovered).toBe(true)
  expect(existsSync(result.temporaryDataDir)).toBe(false)
}, 120_000)

test("Explicit user material retains surrounding requirements and retrieves exact archived original", async () => {
  const result = await runHeadroomEvaluation({ fixtures: [makeHeadroomFixture("user-material", 50), makeHeadroomFixture("requirement-correction", 50)], replaySteps: 2 })
  for (const comparison of result.comparisons) {
    expect(comparison.layered.quality.constraintsFound).toBe(comparison.layered.quality.constraintsTotal)
    expect(comparison.layered.quality.sourceRecovered).toBe(true)
    expect(comparison.layered.retrievalTokens).toBeGreaterThan(0)
  }
}, 120_000)

test("Original evidence remains recoverable after planning generations 2, 5 and 20", async () => {
  const result = await runHeadroomEvaluation({ fixtures: [makeHeadroomFixture("multi-generation", 200)], strategies: ["layered"], replaySteps: 20, recoveryCheckpoints: [2, 5, 20] })
  const row = result.comparisons[0]!.layered
  expect(row.recoveryCheckpoints.map((p) => p.step)).toEqual([2, 5, 20])
  expect(row.recoveryCheckpoints.every((p) => p.exact)).toBe(true)
  expect(row.operations.analyzedMessages).toBeLessThanOrEqual(400)
  expect(row.operations.analysisCacheHits).toBeGreaterThan(400)
}, 120_000)

test("A compression timeout stops the group at the first failed stage and cannot claim savings", async () => {
  // A 5ms deadline for every RPC can fail hydration before compression.
  // Inject only the compression failure; retain the real runtime and cleanup.
  const message = "headroomd: compress timed out (injected)"
  const compress = spyOn(HeadroomClient.prototype, "compress").mockRejectedValue(new Error(message))
  try {
    const result = await runHeadroomEvaluation({ fixtures: [makeHeadroomFixture("unique-code", 1000)], strategies: ["layered"], replaySteps: 4 })
    const comparison = result.comparisons[0]!
    expect(comparison.layered.status).toBe("incomplete")
    expect(comparison.layered.errors).toEqual([message])
    expect(comparison.layered.operations.compressCalls).toBe(1)
    expect(comparison.layered.calls).toHaveLength(1)
    expect(comparison.savingsRatio).toBeNull()
    expect(comparison.target25PercentMet).toBeNull()
    expect(existsSync(result.temporaryDataDir)).toBe(false)
  } finally {
    compress.mockRestore()
  }
}, 30_000)

test("Existing engineering replay accounts for every original question and preserves its active user request", async () => {
  const { engineeringHeadroomFixture } = await import("../src/headroom-fixtures")
  const result = await runHeadroomEvaluation({ fixtures: [engineeringHeadroomFixture()] })
  for (const row of [result.comparisons[0]!.legacy!, result.comparisons[0]!.layered]) {
    expect(row.quality.naturalProbes).toHaveLength(10)
    expect(row.quality.protectedMessagesIntact).toBe(true)
    expect(row.quality.constraintsFound).toBe(row.quality.constraintsTotal)
    expect(row.calls.filter((call) => call.phase === "query")).toHaveLength(10)
  }
}, 120_000)
