/**
 * Metrics unit tests with exact numeric assertions (brief requirement #2).
 *
 * Constructs known inputs and asserts compression ratio / recall / percentiles
 * precisely — no real token counting involved (records are built directly).
 */
import { describe, expect, test } from "bun:test";
import {
  computeCompressionRatio,
  computeGroupMetrics,
  evaluateRecall,
  buildPerFixtureRecord,
  aggregateReport,
  type PerFixtureRecord,
  type LatencySample,
  type RecallResult,
} from "../src/metrics";
import type { FixtureSample } from "../src/fixtures";

// NOTE: do NOT call dispose() here between tests — metrics.ts holds a module
// -level ExactTokenCounter singleton and dispose() permanently invalidates it
// ("shared: ExactTokenCounter already disposed"), poisoning every later test.
// The wasm instance is freed at process exit.

describe("metrics: computeCompressionRatio", () => {
  test("exact ratios", () => {
    expect(computeCompressionRatio(1000, 250)).toBe(0.25);
    expect(computeCompressionRatio(1000, 1000)).toBe(1.0);
    expect(computeCompressionRatio(4, 1)).toBe(0.25);
  });

  test("zero raw tokens degenerates to 1.0 (no division by zero)", () => {
    expect(computeCompressionRatio(0, 0)).toBe(1.0);
    expect(computeCompressionRatio(0, 100)).toBe(1.0);
  });
});

// --- helpers to build controlled metric inputs -----------------------------

function record(partial: Partial<PerFixtureRecord> & { fixture: string; group: PerFixtureRecord["group"] }): PerFixtureRecord {
  return {
    rawTokens: 1000,
    outTokens: 500,
    latencyMs: 10,
    recallHits: [],
    recallMisses: [],
    degradedReason: null,
    ...partial,
  };
}

function recall(partial: Partial<RecallResult> & { fixture: string; group: RecallResult["group"] }): RecallResult {
  return {
    hits: [],
    misses: [],
    mustHitTotal: 2,
    mustHitFound: 2,
    niceToHaveTotal: 1,
    niceToHaveFound: 1,
    ...partial,
  };
}

describe("metrics: computeGroupMetrics", () => {
  test("compression ratio aggregates across the group's fixtures only", () => {
    const perFixture: PerFixtureRecord[] = [
      record({ fixture: "f1", group: "B", rawTokens: 1000, outTokens: 500 }),
      record({ fixture: "f2", group: "B", rawTokens: 3000, outTokens: 1500 }),
      record({ fixture: "other", group: "A", rawTokens: 9999, outTokens: 9999 }),
    ];
    const m = computeGroupMetrics("B", perFixture, [], []);
    // (500 + 1500) / (1000 + 3000) = 0.5
    expect(m.compressionRatio).toBe(0.5);
  });

  test("latency percentiles follow ceil(p/100*n)-1 over sorted samples", () => {
    const latencies: LatencySample[] = [40, 10, 30, 20].map((latencyMs, i) => ({
      group: "B",
      fixture: `f${i}`,
      latencyMs,
    }));
    const m = computeGroupMetrics("B", [], latencies, []);
    // sorted [10,20,30,40]: p50 -> idx ceil(0.5*4)-1=1 -> 20; p95 -> idx ceil(3.8)-1=3 -> 40
    expect(m.latencyP50Ms).toBe(20);
    expect(m.latencyP95Ms).toBe(40);
  });

  test("recall rates aggregate must-hit separately from nice-to-have", () => {
    const recalls: RecallResult[] = [
      recall({ fixture: "f1", group: "D", mustHitTotal: 4, mustHitFound: 4, niceToHaveTotal: 2, niceToHaveFound: 0 }),
      recall({ fixture: "f2", group: "D", mustHitTotal: 4, mustHitFound: 2, niceToHaveTotal: 2, niceToHaveFound: 2 }),
    ];
    const m = computeGroupMetrics("D", [], [], recalls);
    expect(m.recall.mustHit).toEqual({ found: 6, total: 8, rate: 0.75 });
    expect(m.recall.niceToHave).toEqual({ found: 2, total: 4, rate: 0.5 });
  });

  test("recall rate defaults to 1 when a group has no golden facts at all", () => {
    const m = computeGroupMetrics("A", [], [], []);
    expect(m.recall.mustHit.rate).toBe(1);
    expect(m.recall.niceToHave.rate).toBe(1);
  });

  test("degraded counts tally reasons and rate against total fixtures", () => {
    const perFixture: PerFixtureRecord[] = [
      record({ fixture: "a", group: "B", degradedReason: "timeout" }),
      record({ fixture: "b", group: "B", degradedReason: "no_gain" }),
      record({ fixture: "c", group: "B", degradedReason: null }),
      record({ fixture: "d", group: "B", degradedReason: "timeout" }),
    ];
    const m = computeGroupMetrics("B", perFixture, [], []);
    expect(m.degradedRate.timeout).toBe(2);
    expect(m.degradedRate.no_gain).toBe(1);
    expect(m.degradedRate.crash).toBe(0);
    expect(m.degradedRate.total).toBe(3);
    expect(m.degradedRate.rate).toBe(0.75);
  });
});

describe("metrics: evaluateRecall", () => {
  const fixture: FixtureSample = {
    name: "t",
    description: "t",
    messages: [],
    goldenFacts: {
      mustHit: ["fact-in-output", "fact-in-snippet"],
      niceToHave: ["fact-in-fetch"],
    },
  };

  test("matches across compressed output, retrieve snippets, and fetch content", () => {
    const r = evaluateRecall(
      fixture,
      "D",
      "prefix fact-in-output suffix",
      [{ score: 0.9, hash: "a".repeat(64), projectId: "default", sessionId: "s", turnIndex: 0, role: "user", snippet: "has fact-in-snippet" }],
      "fetch body fact-in-fetch",
    );
    expect(r.mustHitFound).toBe(2);
    expect(r.misses).toEqual([]);
    expect(r.hits).toEqual(["fact-in-output", "fact-in-snippet"]);
    expect(r.niceToHaveFound).toBe(1);
  });

  test("null compressed output with no hits means total miss", () => {
    const r = evaluateRecall(fixture, "C", null, [], null);
    expect(r.mustHitFound).toBe(0);
    expect(r.misses).toEqual(fixture.goldenFacts.mustHit);
  });
});

describe("metrics: buildPerFixtureRecord / aggregateReport", () => {
  test("record counts tokens of provided texts via o200k_base exact counter", () => {
    const f: FixtureSample = { name: "n", description: "n", messages: [], goldenFacts: { mustHit: [], niceToHave: [] } };
    const r = buildPerFixtureRecord(f, "A", "hello world", "hello world hello world", 5, [], [], null);
    expect(r.rawTokens).toBeGreaterThan(0);
    // Same text counted twice must agree; doubled text should count more.
    expect(r.outTokens).toBeGreaterThanOrEqual(r.rawTokens);
  });

  test("aggregateReport produces the FullReport shape for all four groups", () => {
    const rep = aggregateReport([], [], []);
    expect(rep.meta.tokenCounter).toBe("o200k_base");
    expect(Object.keys(rep.groups).sort()).toEqual(["A", "B", "C", "D"]);
    expect(typeof rep.meta.versions.bun).toBe("string");
    expect(rep.perFixture).toEqual([]);
  });
});
