import { validateReliability } from "../src/reliability"
/** Baseline tests use private files and never substitute tracked artifacts. */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  checkBaseline as checkBaselineImpl,
  validateReportStructure,
  BASELINE_PATH as TRACKED_BASELINE,
} from "../src/check-baseline"
import { writeReport as writeReportImpl, REPORT_PATH as TRACKED_REPORT } from "../src/report"
import { aggregateReplay, type ReplayMetrics } from "../src/replay-metrics"
import type { FullReport, GroupMetrics } from "../src/metrics"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
let tempDir: string
let BASELINE_PATH: string
let REPORT_PATH: string
let originalBaseline: string
let originalReport: string | null
const writeReport = (report: FullReport) => writeReportImpl(report, REPORT_PATH)
const checkBaseline = (update = false, opts: { skipLatency?: boolean } = {}) =>
  checkBaselineImpl(update, { ...opts, baselinePath: BASELINE_PATH, reportPath: REPORT_PATH })

function replay(group: string): ReplayMetrics {
  const inputTokens = group === "A" ? 100 : 50
  return {
    adapter: "@bluecode/plugin/runtime",
    retrievalStrategy: "query-only",
    modelCalls: [{ phase: "host", inputTokens, retrievalTokens: 0 }],
    totalInputTokens: inputTokens,
    retrievalOutputTokens: 0,
    critical: { found: 3, total: 3 },
    naturalRecallAt5: { found: 10, total: 10, misses: [] },
    tasks: { passed: 10, total: 10, failures: [] },
    violations: { crossNamespace: 0, stalePlan: 0, retrievalRecompression: 0 },
    probes: { crossNamespace: 1, stalePlan: 1, retrievalRecompression: 1 },
    runtime: { rtkCalls: 0, plans: 0, applied: 0, errors: 0 },
    latency: {
      toolHookMs: 0,
      transformMs: 0,
      planningDrainMs: 0,
      retrievalMs: 0,
      archiveProbeMs: 0,
      queueMs: null,
      serviceMs: null,
      deadlineMs: 40,
    },
    rssBytes: 100,
  }
}

function groupMetrics(overrides: Partial<GroupMetrics>): GroupMetrics {
  return {
    compressionRatio: 0.5,
    longOutputRatio: 0.5,
    latencyP50Ms: 10,
    latencyP95Ms: 100,
    contextRecall: {
      mustHit: { found: 2, total: 2, rate: 1 },
      niceToHave: { found: 1, total: 1, rate: 1 },
    },
    queryRecall: {
      mustHit: { found: 0, total: 0, rate: 1 },
      niceToHave: { found: 0, total: 0, rate: 1 },
    },
    archiveRecovery: { found: 0, total: 0, rate: 1 },
    degradedRate: {
      spawn_failed: 0,
      timeout: 0,
      crash: 0,
      protocol: 0,
      no_gain: 0,
      total: 0,
      rate: 0,
    },
    ...overrides,
  }
}

function makeReport(opts: {
  dRatio?: number
  mustHitRate?: number
  p95?: number
  archiveFound?: number
  archiveTotal?: number
}): FullReport {
  const groups = {} as FullReport["groups"]
  for (const g of ["A", "B", "C", "D"] as const) {
    groups[g] = groupMetrics({
      replay: aggregateReplay([replay(g)])!,
      compressionRatio: opts.dRatio ?? 0.5,
      latencyP95Ms: opts.p95 ?? 100,
      ...(g !== "A"
        ? {
            contextRecall: {
              mustHit: { found: 2, total: 2, rate: opts.mustHitRate ?? 1 },
              niceToHave: { found: 1, total: 1, rate: 1 },
            },
            archiveRecovery: {
              found: opts.archiveFound ?? 10,
              total: opts.archiveTotal ?? 10,
              rate:
                (opts.archiveTotal ?? 10) > 0
                  ? (opts.archiveFound ?? 10) / (opts.archiveTotal ?? 10)
                  : 1,
            },
          }
        : {}),
    })
  }
  return {
    meta: {
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenCounter: "o200k_base",
      versions: { node: "test", bun: "test" },
    },
    groups,
    perFixture: (["A", "B", "C", "D"] as const).map((group) => ({
      replay: replay(group),
      fixture: "fixture-1",
      group,
      rawTokens: 100,
      outTokens: 50,
      latencyMs: 10,
      contextRecallHits: ["fact-1", "fact-2"],
      contextRecallMisses: [],
      queryRecallHits: [],
      queryRecallMisses: [],
      archiveRecoveryFound: group === "A" ? 0 : opts.archiveFound ?? 10,
      archiveRecoveryTotal: group === "A" ? 0 : opts.archiveTotal ?? 10,
      degradedReason: null,
    })),
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-gates-"))
  BASELINE_PATH = path.join(tempDir, "baseline.json")
  REPORT_PATH = path.join(tempDir, "report.json")
  originalBaseline = fs.readFileSync(TRACKED_BASELINE, "utf8")
  originalReport = fs.existsSync(TRACKED_REPORT) ? fs.readFileSync(TRACKED_REPORT, "utf8") : null
})
afterEach(() => {
  expect(fs.readFileSync(TRACKED_BASELINE, "utf8")).toBe(originalBaseline)
  expect(fs.existsSync(TRACKED_REPORT) ? fs.readFileSync(TRACKED_REPORT, "utf8") : null).toBe(
    originalReport
  )
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("check-baseline gate logic", () => {
  test("missing baseline.json fails with an explicit violation", () => {
    if (fs.existsSync(BASELINE_PATH)) fs.unlinkSync(BASELINE_PATH)
    writeReport(makeReport({}))
    const r = checkBaseline(false)
    expect(r.passed).toBe(false)
    expect(r.violations[0]?.metric).toBe("baseline")
  })

  test("--update-baseline creates a baseline even when none exists yet", () => {
    // Regression: the missing-baseline early return used to run before the
    // freeze branch, so the first --update-baseline could never write a file.
    if (fs.existsSync(BASELINE_PATH)) fs.unlinkSync(BASELINE_PATH)
    writeReport(makeReport({ dRatio: 0.42 }))
    const r = checkBaseline(true)
    expect(r.passed).toBe(true)
    expect(fs.existsSync(BASELINE_PATH)).toBe(true)
    const frozen = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as FullReport
    expect(frozen.groups.B?.compressionRatio).toBe(0.42)
  })

  test("report within thresholds passes with zero violations", () => {
    // Baseline: ratio 0.5 / mustHit 1.0 / p95 100.
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    // Current: ratio +1pp (within ±2pp), same recall, p95 1.5x (< 2x).
    writeReport(makeReport({ dRatio: 0.51, p95: 150 }))
    const r = checkBaseline(false)
    expect(r.passed).toBe(true)
    expect(r.violations).toEqual([])
  })

  test("compression ratio drift beyond ±2pp fails and names the group", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    writeReport(makeReport({ dRatio: 0.6 })) // +10pp
    const r = checkBaseline(false)
    expect(r.passed).toBe(false)
    const v = r.violations.filter((x) => x.metric === "compressionRatio")
    expect(v.length).toBeGreaterThanOrEqual(1)
    expect(v[0]?.threshold).toContain("±2pp")
  })

  test("any must-hit recall decline fails even when ratios hold", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    writeReport(makeReport({ dRatio: 0.5, mustHitRate: 0.75 }))
    const r = checkBaseline(false)
    expect(r.passed).toBe(false)
    const v = r.violations.filter((x) => x.metric === "mustHitRecall")
    expect(v.length).toBe(3) // B, C, D all decline
  })

  test("archive recovery cannot pass by collapsing a non-empty baseline to 0/0", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    writeReport(makeReport({ archiveFound: 0, archiveTotal: 0 }))
    const r = checkBaseline(false)
    expect(r.passed).toBe(false)
    expect(r.violations.filter((x) => x.metric === "archiveRecoveryTotal")).toHaveLength(3)
  })

  test("p95 latency beyond 2x baseline fails", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    writeReport(makeReport({ p95: 300 }))
    const r = checkBaseline(false)
    expect(r.passed).toBe(false)
    const v = r.violations.filter((x) => x.metric === "latencyP95")
    expect(v.length).toBeGreaterThanOrEqual(1)
  })

  test("sub-millisecond p95 noise does not fail only because its ratio is large", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({ p95: 0.03 })))
    writeReport(makeReport({ p95: 0.18 }))
    const r = checkBaseline(false)
    expect(r.passed).toBe(true)
    expect(r.violations.filter((x) => x.metric === "latencyP95")).toEqual([])
  })

  test("combined violations are listed together, not short-circuited", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    writeReport(makeReport({ dRatio: 0.9, mustHitRate: 0.5, p95: 500 }))
    const r = checkBaseline(false)
    expect(r.passed).toBe(false)
    const metrics = new Set(r.violations.map((v) => v.metric))
    expect(metrics.has("compressionRatio")).toBe(true)
    expect(metrics.has("mustHitRecall")).toBe(true)
    expect(metrics.has("latencyP95")).toBe(true)
  })

  // --- skipLatency opt-out: ONLY the latencyP95 gate may be silenced -------

  function withSkipLatencyEnv(run: () => void): void {
    // Save / restore / delete so neither this suite nor sibling suites inherit
    // an opt-out that was meant for a single case.
    const prev = process.env.EVAL_SKIP_LATENCY
    try {
      process.env.EVAL_SKIP_LATENCY = "1"
      run()
    } finally {
      if (prev === undefined) delete process.env.EVAL_SKIP_LATENCY
      else process.env.EVAL_SKIP_LATENCY = prev
    }
  }

  test("p95 violation alone is suppressed under skipLatency flag", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    writeReport(makeReport({ p95: 300 })) // would fail without the opt-out
    const r = checkBaseline(false, { skipLatency: true })
    expect(r.passed).toBe(true)
    expect(r.violations.filter((x) => x.metric === "latencyP95")).toEqual([])
  })

  test("p95 violation alone is suppressed under EVAL_SKIP_LATENCY=1", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    writeReport(makeReport({ p95: 300 }))
    let r!: ReturnType<typeof checkBaseline>
    withSkipLatencyEnv(() => {
      r = checkBaseline(false)
    })
    expect(r.passed).toBe(true)
    expect(r.violations.filter((x) => x.metric === "latencyP95")).toEqual([])
  })

  test("compression and recall violations still fire under skipLatency", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})))
    writeReport(makeReport({ dRatio: 0.9, mustHitRate: 0.5, p95: 500 }))
    let r!: ReturnType<typeof checkBaseline>
    withSkipLatencyEnv(() => {
      r = checkBaseline(false, { skipLatency: true })
    })
    expect(r.passed).toBe(false)
    const metrics = new Set(r.violations.map((v) => v.metric))
    expect(metrics.has("compressionRatio")).toBe(true)
    expect(metrics.has("mustHitRecall")).toBe(true)
    // The opt-out must not silently widen into a blanket pass.
    expect(metrics.has("latencyP95")).toBe(false)
  })

  test("updateBaseline freeze is unaffected by skipLatency", () => {
    if (fs.existsSync(BASELINE_PATH)) fs.unlinkSync(BASELINE_PATH)
    // Relative ratio/latency changes may freeze only when absolute correctness passes.
    writeReport(makeReport({ dRatio: 0.9, p95: 9000 }))
    const viaFlag = checkBaseline(true, { skipLatency: true })
    expect(viaFlag.passed).toBe(true)
    expect(JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as FullReport).toMatchObject({
      groups: { A: { compressionRatio: 0.9 } },
    })

    fs.unlinkSync(BASELINE_PATH)
    let viaEnv!: ReturnType<typeof checkBaseline>
    withSkipLatencyEnv(() => {
      viaEnv = checkBaseline(true)
    })
    expect(viaEnv.passed).toBe(true)
    expect(fs.existsSync(BASELINE_PATH)).toBe(true)
  })

  test("rejects duplicate/missing fixture rows, negative tokens and invalid degraded values", () => {
    const baseline = makeReport({})
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline))
    const malformed = makeReport({})
    malformed.perFixture.push({ ...malformed.perFixture[0]! })
    malformed.perFixture[1]!.rawTokens = -1
    ;(malformed.perFixture[2] as any).degradedReason = "mystery"
    writeReport(malformed)

    const result = checkBaseline(false)

    expect(result.passed).toBe(false)
    const metrics = result.violations.map((violation) => violation.metric)
    expect(metrics).toContain("report.fixtureRows")
    expect(metrics).toContain("report.tokens")
    expect(metrics).toContain("report.degradedReason")
  })

  test("rejects inconsistent context recall totals across A/B/C/D", () => {
    const baseline = makeReport({})
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline))
    const malformed = makeReport({})
    malformed.groups.D.contextRecall.mustHit.total = 99
    writeReport(malformed)
    const result = checkBaseline(false)
    expect(result.passed).toBe(false)
    expect(result.violations.map((violation) => violation.metric)).toContain("report.recallTotals")
  })
})

test("baseline refresh rejects a report that loses critical facts even with latency skipped", () => {
  const report = makeReport({})
  report.groups.D.replay!.critical = { found: 1, total: 3, rate: 1 / 3 }
  writeReport(report)
  const result = checkBaseline(true, { skipLatency: true })
  expect(result.passed).toBe(false)
  expect(fs.existsSync(BASELINE_PATH)).toBe(false)
})

test("absolute natural recall and net input targets cannot be frozen into a weak baseline", () => {
  const report = makeReport({})
  const row = report.perFixture.find((r) => r.group === "D")!.replay!
  row.naturalRecallAt5 = { found: 8, total: 10, misses: ["q9", "q10"] }
  row.totalInputTokens = 99
  row.modelCalls[0]!.inputTokens = 99
  report.groups.D.replay = aggregateReplay([row])!
  writeReport(report)
  const result = checkBaseline(true, { skipLatency: true })
  expect(result.passed).toBe(false)
  expect(result.violations.map((v) => v.metric)).toContain("naturalRecallAt5")
  expect(result.violations.map((v) => v.metric)).toContain("combinedNetInput")
  expect(fs.existsSync(BASELINE_PATH)).toBe(false)
})

test("malformed reports are rejected before attempting reliability metric dereferences", () => {
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ groups: null, perFixture: [] }))
  expect(checkBaseline(true).passed).toBe(false)
})

test("zero-tolerance correctness gates reject archival loss and stale, foreign or recompressed evidence", () => {
  const report = makeReport({ archiveFound: 9, archiveTotal: 10 })
  const row = report.perFixture.find((r) => r.group === "D")!.replay!
  row.violations = { crossNamespace: 1, stalePlan: 1, retrievalRecompression: 1 }
  report.groups.D.replay = aggregateReplay([row])!
  writeReport(report)
  const result = checkBaseline(true)
  expect(result.passed).toBe(false)
  for (const metric of [
    "archiveEquality",
    "crossNamespace",
    "stalePlan",
    "retrievalRecompression",
  ]) {
    expect(result.violations.map((v) => v.metric)).toContain(metric)
  }
  expect(fs.existsSync(BASELINE_PATH)).toBe(false)
})

test("partially shaped replay metadata fails validation instead of crashing baseline refresh", () => {
  const report = makeReport({})
  ;(report.groups.D as any).replay = {}
  writeReport(report)
  expect(checkBaseline(true).passed).toBe(false)
})

test("natural recall gate uses actual hit counts even if a supplied rate claims success", () => {
  const report = makeReport({})
  report.groups.D.replay!.naturalRecallAt5 = { found: 0, total: 10, rate: 1 }
  writeReport(report)
  expect(checkBaseline(true).passed).toBe(false)
})

for (const [name, mutate] of [
  [
    "critical loss",
    (r: FullReport["perFixture"][number]) => {
      r.replay!.critical.found = 0
    },
  ],
  [
    "task failure",
    (r: FullReport["perFixture"][number]) => {
      r.replay!.tasks.passed = 0
    },
  ],
  [
    "natural recall loss",
    (r: FullReport["perFixture"][number]) => {
      r.replay!.naturalRecallAt5.found = 0
    },
  ],
  [
    "archive loss",
    (r: FullReport["perFixture"][number]) => {
      r.archiveRecoveryFound = 0
    },
  ],
  [
    "namespace leakage",
    (r: FullReport["perFixture"][number]) => {
      r.replay!.violations.crossNamespace = 1
    },
  ],
  [
    "hidden call",
    (r: FullReport["perFixture"][number]) => {
      r.replay!.modelCalls.push({ phase: "host", inputTokens: 0, retrievalTokens: 0 })
    },
  ],
  [
    "retrieval token drift",
    (r: FullReport["perFixture"][number]) => {
      r.replay!.retrievalOutputTokens++
    },
  ],
  [
    "probe drift",
    (r: FullReport["perFixture"][number]) => {
      r.replay!.probes.stalePlan++
    },
  ],
  [
    "RSS drift",
    (r: FullReport["perFixture"][number]) => {
      r.replay!.rssBytes++
    },
  ],
] as const) {
  test(`row ${name} cannot hide behind unchanged successful group summaries`, () => {
    const report = makeReport({})
    mutate(report.perFixture.find((row) => row.group === "D")!)
    expect(validateReportStructure(report).length).toBeGreaterThan(0)
    expect(validateReliability(report).length).toBeGreaterThan(0)
    writeReport(report)
    expect(checkBaseline(true).passed).toBe(false)
    expect(fs.existsSync(BASELINE_PATH)).toBe(false)
  })
}
