import { expect, test } from "bun:test"
import { runEvaluation } from "../src/runner"
import { aggregateReport } from "../src/metrics"
import { allFixtures } from "../src/fixtures"

// Removing the real runtime or failing to reuse its durable view must break this.
test("actual plugin replay uses fresh host arrays, measures every call and verifies exact archives", async () => {
  const result = await runEvaluation({ fixtures: [allFixtures()[0]!], replaySteps: 3 })
  const report = aggregateReport(result.perFixture, result.latencies, result.recallResults)
  for (const group of ["A", "B", "C", "D"] as const) {
    const row = result.perFixture.find((r) => r.group === group)!
    expect(row.replay?.adapter).toBe("@bluecode/plugin/runtime")
    expect(row.replay?.modelCalls.length).toBeGreaterThanOrEqual(6)
    expect(row.replay?.totalInputTokens).toBe(
      row.replay?.modelCalls.reduce((n, c) => n + c.inputTokens, 0)
    )
    expect(report.groups[group].replay?.totalInputTokens).toBe(row.replay?.totalInputTokens)
    expect(row.replay?.violations.retrievalRecompression).toBe(0)
    expect(row.replay?.violations.crossNamespace).toBe(0)
    if (group === "C" || group === "D") {
      expect(row.replay?.probes.stalePlan).toBeGreaterThan(0)
      expect(row.replay?.probes.crossNamespace).toBeGreaterThan(0)
    }
    expect(row.archiveRecoveryFound).toBe(row.archiveRecoveryTotal)
  }
  expect(result.perFixture.find((r) => r.group === "B")!.replay!.runtime.rtkCalls).toBeGreaterThan(
    0
  )
}, 120_000)

test("fixed query-only policy retains task quality while eager recovery exposes its extra token cost", async () => {
  const fixtures = [allFixtures().find((f) => f.name === "engineering-replay")!]
  const queryOnly = await runEvaluation({ fixtures, retrievalStrategy: "query-only" })
  const eager = await runEvaluation({ fixtures, retrievalStrategy: "eager-recovery" })
  for (const group of ["C", "D"] as const) {
    const q = queryOnly.perFixture.find((r) => r.group === group)!.replay!
    const e = eager.perFixture.find((r) => r.group === group)!.replay!
    expect(q.tasks.passed).toBe(q.tasks.total)
    expect(q.naturalRecallAt5.found).toBe(q.naturalRecallAt5.total)
    expect(q.totalInputTokens).toBeLessThan(e.totalInputTokens)
    expect(q.retrievalOutputTokens).toBeLessThan(e.retrievalOutputTokens)
  }
}, 60_000)

test("real query-only replay scores evidence from a hit continuation instead of dropping its later pages", async () => {
  const fixture = structuredClone(allFixtures().find((f) => f.name === "engineering-replay")!)
  fixture.name = "paged-query-evidence"
  const answer = "LATE-PAGE-ANSWER-739"
  fixture.messages[1]!.parts[0] = {
    type: "text",
    text: "Needle paragraph evidence. ".repeat(420) + answer,
  }
  fixture.goldenFacts = { mustHit: [answer], niceToHave: [] }
  fixture.questions = [
    {
      question: "What was the needle paragraph evidence?",
      query: "What was the needle paragraph evidence?",
      expected: [answer],
    },
  ]
  const result = await runEvaluation({
    fixtures: [fixture],
    replaySteps: 1,
    retrievalStrategy: "query-only",
  })
  for (const group of ["C", "D"] as const) {
    const replay = result.perFixture.find((row) => row.group === group)!.replay!
    expect(
      replay.modelCalls.filter((call) => call.phase === "retrieval").length
    ).toBeGreaterThanOrEqual(3)
    expect(replay.naturalRecallAt5).toEqual({ found: 1, total: 1, misses: [] })
  }
}, 30_000)
