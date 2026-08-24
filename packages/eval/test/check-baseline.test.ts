/**
 * Regression gate logic (brief requirement #4).
 *
 * checkBaseline() reads fixed paths relative to the process CWD, so these
 * tests back up any real eval-report.json / baseline.json, substitute
 * controlled ones, and restore afterwards — order-independent and safe to
 * run before or after a real baseline exists.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { checkBaseline, BASELINE_PATH } from "../src/check-baseline";
import { writeReport, REPORT_PATH } from "../src/report";
import type { FullReport, GroupMetrics } from "../src/metrics";
import fs from "node:fs";

// The gate reads module-relative fixed paths (CWD-independent), so the tests
// substitute controlled files at those same exported constants.

let backupReport: string | null = null;
let backupBaseline: string | null = null;

function groupMetrics(overrides: Partial<GroupMetrics>): GroupMetrics {
  return {
    compressionRatio: 0.5,
    longOutputRatio: 0.5,
    latencyP50Ms: 10,
    latencyP95Ms: 100,
    recall: {
      mustHit: { found: 2, total: 2, rate: 1 },
      niceToHave: { found: 1, total: 1, rate: 1 },
    },
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
  };
}

function makeReport(opts: { dRatio?: number; mustHitRate?: number; p95?: number }): FullReport {
  const groups = {} as FullReport["groups"];
  for (const g of ["A", "B", "C", "D"] as const) {
    groups[g] = groupMetrics({
      compressionRatio: opts.dRatio ?? 0.5,
      latencyP95Ms: opts.p95 ?? 100,
      ...(g !== "A"
        ? { recall: { mustHit: { found: 2, total: 2, rate: opts.mustHitRate ?? 1 }, niceToHave: { found: 1, total: 1, rate: 1 } } }
        : {}),
    });
  }
  return {
    meta: { timestamp: "2026-01-01T00:00:00.000Z", tokenCounter: "o200k_base", versions: { node: "test", bun: "test" } },
    groups,
    perFixture: [],
  };
}

beforeEach(() => {
  backupReport = fs.existsSync(REPORT_PATH) ? fs.readFileSync(REPORT_PATH, "utf8") : null;
  backupBaseline = fs.existsSync(BASELINE_PATH) ? fs.readFileSync(BASELINE_PATH, "utf8") : null;
});

afterEach(() => {
  if (backupReport !== null) fs.writeFileSync(REPORT_PATH, backupReport);
  else if (fs.existsSync(REPORT_PATH)) fs.unlinkSync(REPORT_PATH);
  if (backupBaseline !== null) fs.writeFileSync(BASELINE_PATH, backupBaseline);
  else if (fs.existsSync(BASELINE_PATH)) fs.unlinkSync(BASELINE_PATH);
});

describe("check-baseline gate logic", () => {
  test("missing baseline.json fails with an explicit violation", () => {
    if (fs.existsSync(BASELINE_PATH)) fs.unlinkSync(BASELINE_PATH);
    writeReport(makeReport({}));
    const r = checkBaseline(false);
    expect(r.passed).toBe(false);
    expect(r.violations[0]?.metric).toBe("baseline");
  });

  test("--update-baseline creates a baseline even when none exists yet", () => {
    // Regression: the missing-baseline early return used to run before the
    // freeze branch, so the first --update-baseline could never write a file.
    if (fs.existsSync(BASELINE_PATH)) fs.unlinkSync(BASELINE_PATH);
    writeReport(makeReport({ dRatio: 0.42 }));
    const r = checkBaseline(true);
    expect(r.passed).toBe(true);
    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
    const frozen = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as FullReport;
    expect(frozen.groups.B?.compressionRatio).toBe(0.42);
  });

  test("report within thresholds passes with zero violations", () => {
    // Baseline: ratio 0.5 / mustHit 1.0 / p95 100.
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})));
    // Current: ratio +1pp (within ±2pp), same recall, p95 1.5x (< 2x).
    writeReport(makeReport({ dRatio: 0.51, p95: 150 }));
    const r = checkBaseline(false);
    expect(r.passed).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test("compression ratio drift beyond ±2pp fails and names the group", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})));
    writeReport(makeReport({ dRatio: 0.6 })); // +10pp
    const r = checkBaseline(false);
    expect(r.passed).toBe(false);
    const v = r.violations.filter((x) => x.metric === "compressionRatio");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]?.threshold).toContain("±2pp");
  });

  test("any must-hit recall decline fails even when ratios hold", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})));
    writeReport(makeReport({ dRatio: 0.5, mustHitRate: 0.75 }));
    const r = checkBaseline(false);
    expect(r.passed).toBe(false);
    const v = r.violations.filter((x) => x.metric === "mustHitRecall");
    expect(v.length).toBe(3); // B, C, D all decline
  });

  test("p95 latency beyond 2x baseline fails", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})));
    writeReport(makeReport({ p95: 300 }));
    const r = checkBaseline(false);
    expect(r.passed).toBe(false);
    const v = r.violations.filter((x) => x.metric === "latencyP95");
    expect(v.length).toBeGreaterThanOrEqual(1);
  });

  test("combined violations are listed together, not short-circuited", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})));
    writeReport(makeReport({ dRatio: 0.9, mustHitRate: 0.5, p95: 500 }));
    const r = checkBaseline(false);
    expect(r.passed).toBe(false);
    const metrics = new Set(r.violations.map((v) => v.metric));
    expect(metrics.has("compressionRatio")).toBe(true);
    expect(metrics.has("mustHitRecall")).toBe(true);
    expect(metrics.has("latencyP95")).toBe(true);
  });

  // --- skipLatency opt-out: ONLY the latencyP95 gate may be silenced -------

  function withSkipLatencyEnv(run: () => void): void {
    // Save / restore / delete so neither this suite nor sibling suites inherit
    // an opt-out that was meant for a single case.
    const prev = process.env.EVAL_SKIP_LATENCY;
    try {
      process.env.EVAL_SKIP_LATENCY = "1";
      run();
    } finally {
      if (prev === undefined) delete process.env.EVAL_SKIP_LATENCY;
      else process.env.EVAL_SKIP_LATENCY = prev;
    }
  }

  test("p95 violation alone is suppressed under skipLatency flag", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})));
    writeReport(makeReport({ p95: 300 })); // would fail without the opt-out
    const r = checkBaseline(false, { skipLatency: true });
    expect(r.passed).toBe(true);
    expect(r.violations.filter((x) => x.metric === "latencyP95")).toEqual([]);
  });

  test("p95 violation alone is suppressed under EVAL_SKIP_LATENCY=1", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})));
    writeReport(makeReport({ p95: 300 }));
    let r!: ReturnType<typeof checkBaseline>;
    withSkipLatencyEnv(() => {
      r = checkBaseline(false);
    });
    expect(r.passed).toBe(true);
    expect(r.violations.filter((x) => x.metric === "latencyP95")).toEqual([]);
  });

  test("compression and recall violations still fire under skipLatency", () => {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(makeReport({})));
    writeReport(makeReport({ dRatio: 0.9, mustHitRate: 0.5, p95: 500 }));
    let r!: ReturnType<typeof checkBaseline>;
    withSkipLatencyEnv(() => {
      r = checkBaseline(false, { skipLatency: true });
    });
    expect(r.passed).toBe(false);
    const metrics = new Set(r.violations.map((v) => v.metric));
    expect(metrics.has("compressionRatio")).toBe(true);
    expect(metrics.has("mustHitRecall")).toBe(true);
    // The opt-out must not silently widen into a blanket pass.
    expect(metrics.has("latencyP95")).toBe(false);
  });

  test("updateBaseline freeze is unaffected by skipLatency", () => {
    if (fs.existsSync(BASELINE_PATH)) fs.unlinkSync(BASELINE_PATH);
    // Even a maximally-violating report freezes fine — freezing never compares.
    writeReport(makeReport({ dRatio: 0.9, mustHitRate: 0.25, p95: 9000 }));
    const viaFlag = checkBaseline(true, { skipLatency: true });
    expect(viaFlag.passed).toBe(true);
    expect(JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as FullReport).toMatchObject({
      groups: { A: { compressionRatio: 0.9 } },
    });

    fs.unlinkSync(BASELINE_PATH);
    let viaEnv!: ReturnType<typeof checkBaseline>;
    withSkipLatencyEnv(() => {
      viaEnv = checkBaseline(true);
    });
    expect(viaEnv.passed).toBe(true);
    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
  });
});
