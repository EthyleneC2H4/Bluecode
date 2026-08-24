/**
 * Regression gate: compare eval-report.json against baseline.json.
 *
 * Exit codes:
 *  0 = pass
 *  1 = failure (with violations printed)
 */
import path from "node:path";
import fs from "node:fs";
import { readReport } from "./report";
import { type FullReport, type GroupMetrics } from "./metrics";
import { type FixtureSample, allFixtures } from "./fixtures";

// Module-relative — see report.ts for why CWD-relative breaks `bun run eval`.
export const BASELINE_PATH = path.resolve(import.meta.dir, "../baseline.json");

interface Violation {
  metric: string;
  group: string;
  baseline: number;
  current: number;
  threshold: string;
}

function loadBaseline(): FullReport | null {
  if (!fs.existsSync(BASELINE_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

function compareMetrics(baseline: FullReport, current: FullReport, skipLatency: boolean): Violation[] {
  const violations: Violation[] = [];

  // Overall compression ratio: >±2pp (0.02)
  for (const group of ["A", "B", "C", "D"] as const) {
    const b = baseline.groups[group].compressionRatio;
    const c = current.groups[group].compressionRatio;
    const diff = c - b;
    if (Math.abs(diff) > 0.02) {
      violations.push({
        metric: "compressionRatio",
        group,
        baseline: b,
        current: c,
        threshold: `±2pp (diff=${diff.toFixed(4)})`,
      });
    }
  }

  // Must-hit recall: any decline
  for (const group of ["B", "C", "D"] as const) {
    const bRate = baseline.groups[group].recall.mustHit.rate;
    const cRate = current.groups[group].recall.mustHit.rate;
    if (cRate < bRate - 0.0001) { // Allow tiny floating point noise
      violations.push({
        metric: "mustHitRecall",
        group,
        baseline: bRate,
        current: cRate,
        threshold: "no decline allowed",
      });
    }
  }

  // p95 latency: >2x baseline. Sound locally, but flaky on shared CI runners
  // where IPC timing noise dominates — hence the explicit opt-out below.
  // Only this gate may be skipped; compression and recall stay enforced.
  if (!skipLatency) {
    for (const group of ["A", "B", "C", "D"] as const) {
      const b = baseline.groups[group].latencyP95Ms;
      const c = current.groups[group].latencyP95Ms;
      if (b > 0 && c > b * 2) {
        violations.push({
          metric: "latencyP95",
          group,
          baseline: b,
          current: c,
          threshold: `2x baseline (ratio=${(c/b).toFixed(2)})`,
        });
      }
    }
  }

  return violations;
}

export function checkBaseline(updateBaseline = false, opts: { skipLatency?: boolean } = {}): { passed: boolean; violations: Violation[] } {
  // Flag OR env enables the opt-out. Resolving the env var here (not just in
  // the CLI) means every caller — tests included — exercises the same path.
  const skipLatency = opts.skipLatency === true || process.env.EVAL_SKIP_LATENCY === "1";

  // Handle freezing FIRST: the missing-baseline early return below would
  // otherwise make the very first --update-baseline impossible (nothing to
  // compare against yet is exactly when you need to create one).
  if (updateBaseline) {
    const current = readReport();
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2), "utf8");
    console.error("[eval] Baseline updated from current report.");
    return { passed: true, violations: [] };
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error("[eval] No baseline.json found. Run with --update-baseline to create one.");
    return { passed: false, violations: [{ metric: "baseline", group: "N/A", baseline: 0, current: 0, threshold: "missing baseline.json" }] };
  }

  // Announce BEFORE comparing so a green run with a disabled gate still says
  // so — silent weakening of the gate must be impossible to miss.
  if (skipLatency) {
    console.error("[eval] latencyP95 gate skipped (--skip-latency / EVAL_SKIP_LATENCY=1)");
  }

  const current = readReport();
  const violations = compareMetrics(baseline, current, skipLatency);

  if (violations.length > 0) {
    console.error("\n[eval] BASELINE CHECK FAILED — violations:");
    for (const v of violations) {
      console.error(`  - ${v.metric} [${v.group}]: baseline=${v.baseline.toFixed(4)} current=${v.current.toFixed(4)} (${v.threshold})`);
    }
    return { passed: false, violations };
  }

  console.error("[eval] Baseline check PASSED.");
  return { passed: true, violations: [] };
}

export function main(updateBaseline = false): number {
  const result = checkBaseline(updateBaseline);
  return result.passed ? 0 : 1;
}