import { validateReliability, validateReplayConsistency } from "./reliability"
/**
 * Regression gate: compare eval-report.json against baseline.json.
 *
 * Exit codes:
 *  0 = pass
 *  1 = failure (with violations printed)
 */
import path from "node:path"
import fs from "node:fs"
import { readReport } from "./report"
import { type FullReport, type GroupMetrics } from "./metrics"

// Module-relative — see report.ts for why CWD-relative breaks `bun run eval`.
export const BASELINE_PATH = path.resolve(import.meta.dir, "../baseline.json")

interface Violation {
  metric: string
  group: string
  baseline: number
  current: number
  threshold: string
}

function loadBaseline(baselinePath: string): unknown | null {
  if (!fs.existsSync(baselinePath)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  } catch {
    return null
  }
}

const GROUPS = ["A", "B", "C", "D"] as const
const DEGRADED = new Set(["spawn_failed", "timeout", "crash", "protocol", "no_gain"])
const LATENCY_ABSOLUTE_REGRESSION_MS = 1

function structuralViolation(metric: string, label: string, detail: string): Violation {
  return { metric, group: label, baseline: 0, current: 0, threshold: detail }
}

/** Validate every assumption used by baseline comparison before dereferencing it. */
export function validateReportStructure(report: unknown, label = "report"): Violation[] {
  const violations: Violation[] = []
  if (typeof report !== "object" || report === null) {
    return [structuralViolation("report.shape", label, "report must be an object")]
  }
  const candidate = report as Record<string, unknown>
  const groups = candidate.groups as Record<string, any> | undefined
  const rows = candidate.perFixture
  if (typeof groups !== "object" || groups === null || !Array.isArray(rows)) {
    return [
      structuralViolation("report.shape", label, "groups object and perFixture array required"),
    ]
  }

  const recallTotals: string[] = []
  for (const group of GROUPS) {
    const metrics = groups[group]
    const numeric = [
      metrics?.compressionRatio,
      metrics?.latencyP95Ms,
      metrics?.contextRecall?.mustHit?.rate,
      metrics?.contextRecall?.niceToHave?.rate,
      metrics?.archiveRecovery?.rate,
    ]
    if (numeric.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      violations.push(
        structuralViolation(
          "report.shape",
          `${label}:${group}`,
          "required metrics must be finite numbers"
        )
      )
      continue
    }
    if (metrics.replay !== undefined) {
      const replay = metrics.replay
      const required = [
        replay?.totalInputTokens,
        replay?.retrievalOutputTokens,
        replay?.modelCalls,
        replay?.critical?.found,
        replay?.critical?.total,
        replay?.critical?.rate,
        replay?.tasks?.passed,
        replay?.tasks?.total,
        replay?.naturalRecallAt5?.found,
        replay?.naturalRecallAt5?.total,
        replay?.violations?.crossNamespace,
        replay?.violations?.stalePlan,
        replay?.violations?.retrievalRecompression,
      ]
      if (
        required.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)
      ) {
        violations.push(
          structuralViolation(
            "report.replay",
            `${label}:${group}`,
            "replay aggregates must be complete finite nonnegative metrics"
          )
        )
      }
    }
    const mustTotal = metrics.contextRecall?.mustHit?.total
    const niceTotal = metrics.contextRecall?.niceToHave?.total
    if (
      !Number.isInteger(mustTotal) ||
      mustTotal < 0 ||
      !Number.isInteger(niceTotal) ||
      niceTotal < 0
    ) {
      violations.push(
        structuralViolation(
          "report.recallTotals",
          `${label}:${group}`,
          "context recall totals must be non-negative integers"
        )
      )
    } else {
      recallTotals.push(`${mustTotal}:${niceTotal}`)
    }
    const archiveFound = metrics.archiveRecovery?.found
    const archiveTotal = metrics.archiveRecovery?.total
    if (
      !Number.isInteger(archiveFound) ||
      archiveFound < 0 ||
      !Number.isInteger(archiveTotal) ||
      archiveTotal < 0 ||
      archiveFound > archiveTotal
    ) {
      violations.push(
        structuralViolation(
          "report.archiveRecovery",
          `${label}:${group}`,
          "archive recovery found/total must be valid non-negative counts"
        )
      )
    }
  }
  if (recallTotals.length === GROUPS.length && new Set(recallTotals).size !== 1) {
    violations.push(
      structuralViolation("report.recallTotals", label, "A/B/C/D context recall totals must match")
    )
  }

  const fixtureCounts = new Map<string, Map<string, number>>(
    GROUPS.map((group) => [group, new Map<string, number>()])
  )
  for (const row of rows as Array<Record<string, unknown>>) {
    const group = row?.group
    const fixture = row?.fixture
    if (!GROUPS.includes(group as (typeof GROUPS)[number]) || typeof fixture !== "string") {
      violations.push(
        structuralViolation("report.fixtureRows", label, "each row needs a valid group and fixture")
      )
      continue
    }
    const counts = fixtureCounts.get(group as string)!
    counts.set(fixture, (counts.get(fixture) ?? 0) + 1)

    for (const key of ["rawTokens", "outTokens"] as const) {
      const value = row[key]
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        violations.push(
          structuralViolation(
            "report.tokens",
            `${label}:${group}:${fixture}`,
            `${key} must be non-negative`
          )
        )
      }
    }
    const archiveFound = row.archiveRecoveryFound
    const archiveTotal = row.archiveRecoveryTotal
    if (
      typeof archiveFound !== "number" ||
      !Number.isInteger(archiveFound) ||
      archiveFound < 0 ||
      typeof archiveTotal !== "number" ||
      !Number.isInteger(archiveTotal) ||
      archiveTotal < 0 ||
      archiveFound > archiveTotal
    ) {
      violations.push(
        structuralViolation(
          "report.archiveRecovery",
          `${label}:${group}:${fixture}`,
          "archiveRecoveryFound/archiveRecoveryTotal must be valid counts"
        )
      )
    }
    if (row.replay !== undefined) {
      const replay = row.replay as any
      if (
        !Array.isArray(replay?.modelCalls) ||
        typeof replay.totalInputTokens !== "number" ||
        replay.modelCalls.some(
          (call: any) =>
            !Number.isInteger(call?.inputTokens) ||
            call.inputTokens < 0 ||
            !Number.isInteger(call?.retrievalTokens) ||
            call.retrievalTokens < 0
        )
      ) {
        violations.push(
          structuralViolation(
            "report.replay",
            `${label}:${group}:${fixture}`,
            "replay needs exact nonnegative per-call token counts"
          )
        )
      }
    }
    const degradedReason = row.degradedReason
    if (degradedReason !== null && !DEGRADED.has(String(degradedReason))) {
      violations.push(
        structuralViolation(
          "report.degradedReason",
          `${label}:${group}:${fixture}`,
          "unknown degradedReason"
        )
      )
    }
  }

  const expected = new Set(fixtureCounts.get("A")!.keys())
  for (const group of GROUPS) {
    const counts = fixtureCounts.get(group)!
    const exact =
      counts.size === expected.size &&
      [...expected].every((fixture) => counts.get(fixture) === 1) &&
      [...counts.values()].every((count) => count === 1)
    if (!exact) {
      violations.push(
        structuralViolation(
          "report.fixtureRows",
          `${label}:${group}`,
          "every fixture must occur exactly once in every group"
        )
      )
    }
  }
  if (violations.length === 0) {
    violations.push(
      ...validateReplayConsistency(report as FullReport).map((v) =>
        structuralViolation(v.metric, `${label}:${v.group}`, v.target)
      )
    )
  }
  return violations
}

function compareMetrics(
  baseline: FullReport,
  current: FullReport,
  skipLatency: boolean
): Violation[] {
  const violations: Violation[] = []

  // Overall compression ratio: >±2pp (0.02)
  for (const group of GROUPS) {
    const b = baseline.groups[group].compressionRatio
    const c = current.groups[group].compressionRatio
    const diff = c - b
    if (Math.abs(diff) > 0.02) {
      violations.push({
        metric: "compressionRatio",
        group,
        baseline: b,
        current: c,
        threshold: `±2pp (diff=${diff.toFixed(4)})`,
      })
    }
  }

  // Must-hit recall: any decline
  for (const group of ["B", "C", "D"] as const) {
    const bRate = baseline.groups[group].contextRecall.mustHit.rate
    const cRate = current.groups[group].contextRecall.mustHit.rate
    if (cRate < bRate - 0.0001) {
      // Allow tiny floating point noise
      violations.push({
        metric: "mustHitRecall",
        group,
        baseline: bRate,
        current: cRate,
        threshold: "no decline allowed",
      })
    }
  }

  // Archive recovery is a correctness property, not context recall.
  for (const group of ["B", "C", "D"] as const) {
    const baselineFound = baseline.groups[group].archiveRecovery.found
    const baselineTotal = baseline.groups[group].archiveRecovery.total
    const currentFound = current.groups[group].archiveRecovery.found
    const currentTotal = current.groups[group].archiveRecovery.total
    const baselineRate = baseline.groups[group].archiveRecovery.rate
    const currentRate = current.groups[group].archiveRecovery.rate
    if (currentTotal !== baselineTotal) {
      violations.push({
        metric: "archiveRecoveryTotal",
        group,
        baseline: baselineTotal,
        current: currentTotal,
        threshold: "expected archive count must remain exact",
      })
    }
    if (currentFound < baselineFound) {
      violations.push({
        metric: "archiveRecoveryFound",
        group,
        baseline: baselineFound,
        current: currentFound,
        threshold: "recovered archive count may not decline",
      })
    }
    if (currentRate < baselineRate - 0.0001) {
      violations.push({
        metric: "archiveRecovery",
        group,
        baseline: baselineRate,
        current: currentRate,
        threshold: "no decline allowed",
      })
    }
  }

  // p95 latency: >2x baseline and >1ms absolute regression. The absolute
  // floor prevents sub-millisecond passthrough timing noise from looking like
  // a many-fold slowdown while preserving the ratio gate for real work.
  // Shared CI runners can still opt out explicitly below.
  // Only this gate may be skipped; compression and recall stay enforced.
  if (!skipLatency) {
    for (const group of ["A", "B", "C", "D"] as const) {
      const b = baseline.groups[group].latencyP95Ms
      const c = current.groups[group].latencyP95Ms
      if (b > 0 && c > b * 2 && c - b > LATENCY_ABSOLUTE_REGRESSION_MS) {
        violations.push({
          metric: "latencyP95",
          group,
          baseline: b,
          current: c,
          threshold: `2x baseline and +${LATENCY_ABSOLUTE_REGRESSION_MS}ms (ratio=${(c / b).toFixed(
            2
          )}, delta=${(c - b).toFixed(2)}ms)`,
        })
      }
    }
  }

  return violations
}

export function checkBaseline(
  updateBaseline = false,
  opts: { skipLatency?: boolean; baselinePath?: string; reportPath?: string } = {}
): { passed: boolean; violations: Violation[] } {
  // Flag OR env enables the opt-out. Resolving the env var here (not just in
  // the CLI) means every caller — tests included — exercises the same path.
  const baselinePath = opts.baselinePath ?? process.env.EVAL_BASELINE_PATH ?? BASELINE_PATH
  const reportPath = opts.reportPath ?? process.env.EVAL_REPORT_PATH
  const skipLatency = opts.skipLatency === true || process.env.EVAL_SKIP_LATENCY === "1"

  // Handle freezing FIRST: the missing-baseline early return below would
  // otherwise make the very first --update-baseline impossible (nothing to
  // compare against yet is exactly when you need to create one).
  if (updateBaseline) {
    const current = readReport(reportPath)
    const structural = validateReportStructure(current, "current")
    if (structural.length > 0) return { passed: false, violations: structural }
    structural.push(
      ...validateReliability(current).map((v) => ({
        metric: v.metric,
        group: v.group,
        baseline: 0,
        current: v.current ?? 0,
        threshold: v.target,
      }))
    )
    if (structural.length > 0) return { passed: false, violations: structural }
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2), "utf8")
    console.error("[eval] Baseline updated from current report.")
    return { passed: true, violations: [] }
  }

  const baselineUnknown = loadBaseline(baselinePath)
  if (!baselineUnknown) {
    console.error("[eval] No baseline.json found. Run with --update-baseline to create one.")
    return {
      passed: false,
      violations: [
        {
          metric: "baseline",
          group: "N/A",
          baseline: 0,
          current: 0,
          threshold: "missing baseline.json",
        },
      ],
    }
  }

  const currentUnknown = readReport(reportPath)
  const structural = [
    ...validateReportStructure(baselineUnknown, "baseline"),
    ...validateReportStructure(currentUnknown, "current"),
  ]
  if (structural.length > 0) {
    console.error("[eval] Report structure validation FAILED.")
    return { passed: false, violations: structural }
  }
  const baseline = baselineUnknown as FullReport
  const current = currentUnknown as FullReport

  // Announce BEFORE comparing so a green run with a disabled gate still says
  // so — silent weakening of the gate must be impossible to miss.
  if (skipLatency) {
    console.error("[eval] latencyP95 gate skipped (--skip-latency / EVAL_SKIP_LATENCY=1)")
  }

  const violations = compareMetrics(baseline, current, skipLatency)

  if (violations.length > 0) {
    console.error("\n[eval] BASELINE CHECK FAILED — violations:")
    for (const v of violations) {
      console.error(
        `  - ${v.metric} [${v.group}]: baseline=${v.baseline.toFixed(
          4
        )} current=${v.current.toFixed(4)} (${v.threshold})`
      )
    }
    return { passed: false, violations }
  }

  console.error("[eval] Baseline check PASSED.")
  return { passed: true, violations: [] }
}

export function main(updateBaseline = false): number {
  const result = checkBaseline(updateBaseline)
  return result.passed ? 0 : 1
}
