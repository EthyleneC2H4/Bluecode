/**
 * Regression gate: compare eval-report.json against baseline.json.
 *
 * Exit codes:
 *  0 = pass
 *  1 = failure (with violations printed)
 */
import { readReport } from "./report";
import { type FullReport, type GroupMetrics } from "./metrics";
import { type FixtureSample, allFixtures } from "./fixtures";

const BASELINE_PATH = "packages/eval/baseline.json";

interface Violation {
  metric: string;
  group: string;
  baseline: number;
  current: number;
  threshold: string;
}

function loadBaseline(): FullReport | null {
  const fs = require("node:fs");
  const path = require("node:path");
  const fullPath = path.resolve(BASELINE_PATH);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function compareMetrics(baseline: FullReport, current: FullReport): Violation[] {
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

  // p95 latency: >2x baseline
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

  return violations;
}

export function checkBaseline(updateBaseline = false): { passed: boolean; violations: Violation[] } {
  const baseline = loadBaseline();
  if (!baseline) {
    console.error("[eval] No baseline.json found. Run with --update-baseline to create one.");
    return { passed: false, violations: [{ metric: "baseline", group: "N/A", baseline: 0, current: 0, threshold: "missing baseline.json" }] };
  }

  const current = readReport();
  const violations = compareMetrics(baseline, current);

  if (updateBaseline) {
    const fs = require("node:fs");
    const path = require("node:path");
    const fullPath = path.resolve(BASELINE_PATH);
    fs.writeFileSync(fullPath, JSON.stringify(current, null, 2), "utf8");
    console.error("[eval] Baseline updated from current report.");
    return { passed: true, violations: [] };
  }

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