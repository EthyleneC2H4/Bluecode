/**
 * JSON report assembly and human-readable summary output.
 */
import path from "node:path"
import fs from "node:fs"
import { aggregateReport, type FullReport } from "./metrics"
import { dispose as disposeMetrics } from "./metrics"

// Module-relative: `bun run eval` executes with --cwd packages/eval, so a
// CWD-relative path would double-resolve into packages/eval/packages/eval.
export const REPORT_PATH = path.resolve(import.meta.dir, "../eval-report.json")

export function writeReport(
  report: FullReport,
  reportPath = process.env.EVAL_REPORT_PATH ?? REPORT_PATH
): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8")
  console.error(`[eval] Report written to ${reportPath}`)
}

export function readReport(reportPath = process.env.EVAL_REPORT_PATH ?? REPORT_PATH): FullReport {
  return JSON.parse(fs.readFileSync(reportPath, "utf8"))
}

export function printSummary(report: FullReport): void {
  const { meta, groups, perFixture } = report
  console.log("Deterministic replay proxy; exact offline text tokens, not external provider usage.")
  for (const group of ["A", "B", "C", "D"] as const) {
    const r = groups[group].replay
    if (r)
      console.log(
        `${group}: totalInput=${r.totalInputTokens}, retrievalOutput=${r.retrievalOutputTokens}, calls=${r.modelCalls}, critical=${r.critical.found}/${r.critical.total}, naturalRecall@5=${r.naturalRecallAt5.found}/${r.naturalRecallAt5.total}, tasks=${r.tasks.passed}/${r.tasks.total}, RSS=${r.peakObservedRssBytes}`
      )
  }
  if (groups.A.replay && groups.D.replay)
    console.log(
      `D net input reduction vs A: ${(
        (1 - groups.D.replay.totalInputTokens / groups.A.replay.totalInputTokens) *
        100
      ).toFixed(2)}%`
    )

  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗")
  console.log("║                           BLUECODE EVAL SUMMARY                              ║")
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")
  console.log(`║  Timestamp: ${meta.timestamp.padEnd(56)} ║`)
  console.log(`║  Token Counter: ${meta.tokenCounter.padEnd(55)} ║`)
  console.log(`║  Node: ${meta.versions.node.padEnd(64)} ║`)
  console.log(`║  Bun: ${meta.versions.bun.padEnd(65)} ║`)
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")
  console.log("║  GROUP METRICS                                                                ║")
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")
  console.log("║  Group │ Comp.Ratio │ LongOut │  P50ms │  P95ms │ CtxHit │ Archive │ Deg%   ║")
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")

  for (const group of ["A", "B", "C", "D"] as const) {
    const g = groups[group]
    const cr = (g.compressionRatio * 100).toFixed(1).padStart(5)
    const lor = (g.longOutputRatio * 100).toFixed(1).padStart(5)
    const p50 = g.latencyP50Ms.toFixed(1).padStart(6)
    const p95 = g.latencyP95Ms.toFixed(1).padStart(6)
    const mh = `${g.contextRecall.mustHit.found}/${g.contextRecall.mustHit.total}`.padStart(7)
    const archive = `${g.archiveRecovery.found}/${g.archiveRecovery.total}`.padStart(8)
    const deg = (g.degradedRate.rate * 100).toFixed(1).padStart(5)

    console.log(
      `║   ${group}    │   ${cr}%   │  ${lor}%  │ ${p50} │ ${p95} │ ${mh} │ ${archive} │ ${deg}%  ║`
    )
  }

  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")
  console.log("║  DEGRADED BREAKDOWN                                                           ║")
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")
  console.log("║  Group │ spawn_failed │ timeout │ crash │ protocol │ no_gain │ total │ rate ║")
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")

  for (const group of ["A", "B", "C", "D"] as const) {
    const g = groups[group]
    const d = g.degradedRate
    console.log(
      `║   ${group}    │     ${d.spawn_failed.toString().padStart(2)}     │  ${d.timeout
        .toString()
        .padStart(2)}  │  ${d.crash.toString().padStart(2)}  │   ${d.protocol
        .toString()
        .padStart(2)}   │   ${d.no_gain.toString().padStart(2)}   │  ${d.total
        .toString()
        .padStart(2)}  │ ${(d.rate * 100).toFixed(1).padStart(4)}% ║`
    )
  }

  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")
  console.log("║  PER-FIXTURE DETAIL (first 10)                                                ║")
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")
  console.log("║  Fixture                    │ Group │ RawTok │ OutTok │ LatMs │ Hits │ Miss ║")
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣")

  for (const f of perFixture.slice(0, 10)) {
    const name = f.fixture.padEnd(28)
    const group = ` ${f.group} `.padEnd(5)
    const raw = f.rawTokens.toString().padStart(6)
    const out = f.outTokens.toString().padStart(6)
    const lat = f.latencyMs.toFixed(1).padStart(6)
    const hits = f.contextRecallHits.length.toString().padStart(4)
    const misses = f.contextRecallMisses.length.toString().padStart(4)
    console.log(`║  ${name} │${group} │ ${raw} │ ${out} │ ${lat} │ ${hits} │ ${misses} ║`)
  }

  if (perFixture.length > 10) {
    console.log(
      `║  ... and ${(perFixture.length - 10)
        .toString()
        .padStart(2)} more fixtures                                              ║`
    )
  }

  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n")
}

export function dispose(): void {
  disposeMetrics()
}
