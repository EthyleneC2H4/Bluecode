/**
 * Five-dimensional metrics computation for evaluation harness.
 *
 * All token counts use js-tiktoken o200k_base via @bluecode/shared exact counter.
 */
import { createExactTokenCounter } from "@bluecode/shared";
import type { CompressResult, HeadroomCompressResult, RetrieveHit } from "@bluecode/contracts";
import type { FixtureSample } from "./fixtures";

export interface LatencySample {
  group: "A" | "B" | "C" | "D";
  fixture: string;
  latencyMs: number;
}

export interface RecallResult {
  fixture: string;
  group: "B" | "C" | "D";
  hits: string[];
  misses: string[];
  mustHitTotal: number;
  mustHitFound: number;
  niceToHaveTotal: number;
  niceToHaveFound: number;
}

export interface DegradedCounts {
  spawn_failed: number;
  timeout: number;
  crash: number;
  protocol: number;
  no_gain: number;
}

export interface GroupMetrics {
  compressionRatio: number;
  longOutputRatio: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  recall: {
    mustHit: { found: number; total: number; rate: number };
    niceToHave: { found: number; total: number; rate: number };
  };
  degradedRate: DegradedCounts & { total: number; rate: number };
}

export interface PerFixtureRecord {
  fixture: string;
  group: "A" | "B" | "C" | "D";
  rawTokens: number;
  outTokens: number;
  latencyMs: number;
  recallHits: string[];
  recallMisses: string[];
  degradedReason: keyof DegradedCounts | null;
}

export interface FullReport {
  meta: {
    timestamp: string;
    tokenCounter: "o200k_base";
    versions: { node: string; bun: string };
  };
  groups: Record<"A" | "B" | "C" | "D", GroupMetrics>;
  perFixture: PerFixtureRecord[];
}

const tokenCounter = createExactTokenCounter();

const LONG_OUTPUT_THRESHOLD = 10240; // 10KB

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function countTokens(text: string): number {
  return tokenCounter.count(text);
}

export function computeCompressionRatio(rawTokens: number, outTokens: number): number {
  if (rawTokens === 0) return 1.0;
  return outTokens / rawTokens;
}

export function computeGroupMetrics(
  group: "A" | "B" | "C" | "D",
  perFixture: PerFixtureRecord[],
  latencies: LatencySample[],
  recallResults: RecallResult[],
): GroupMetrics {
  const groupFixtures = perFixture.filter(f => f.group === group);
  const groupLatencies = latencies.filter(l => l.group === group).map(l => l.latencyMs).sort((a, b) => a - b);
  const groupRecalls = recallResults.filter(r => r.group === group);

  // Overall compression ratio
  const totalRaw = groupFixtures.reduce((sum, f) => sum + f.rawTokens, 0);
  const totalOut = groupFixtures.reduce((sum, f) => sum + f.outTokens, 0);
  const compressionRatio = computeCompressionRatio(totalRaw, totalOut);

  // Long output compression ratio (>10KB)
  const longOutputFixtures = groupFixtures.filter(f => {
    // Approximate: if rawTokens * 4 > 10KB (since ~4 chars/token)
    return f.rawTokens * 4 > LONG_OUTPUT_THRESHOLD;
  });
  const longRaw = longOutputFixtures.reduce((sum, f) => sum + f.rawTokens, 0);
  const longOut = longOutputFixtures.reduce((sum, f) => sum + f.outTokens, 0);
  const longOutputRatio = computeCompressionRatio(longRaw, longOut);

  // Latency percentiles
  const latencyP50Ms = percentile(groupLatencies, 50);
  const latencyP95Ms = percentile(groupLatencies, 95);

  // Recall
  const mustHitTotal = groupRecalls.reduce((sum, r) => sum + r.mustHitTotal, 0);
  const mustHitFound = groupRecalls.reduce((sum, r) => sum + r.mustHitFound, 0);
  const niceToHaveTotal = groupRecalls.reduce((sum, r) => sum + r.niceToHaveTotal, 0);
  const niceToHaveFound = groupRecalls.reduce((sum, r) => sum + r.niceToHaveFound, 0);

  // Degraded rate
  const degradedCounts: DegradedCounts = {
    spawn_failed: 0,
    timeout: 0,
    crash: 0,
    protocol: 0,
    no_gain: 0,
  };
  for (const f of groupFixtures) {
    if (f.degradedReason) {
      degradedCounts[f.degradedReason]++;
    }
  }
  const totalRequests = groupFixtures.length;
  const degradedTotal = Object.values(degradedCounts).reduce((a, b) => a + b, 0);

  return {
    compressionRatio,
    longOutputRatio,
    latencyP50Ms,
    latencyP95Ms,
    recall: {
      mustHit: { found: mustHitFound, total: mustHitTotal, rate: mustHitTotal > 0 ? mustHitFound / mustHitTotal : 1 },
      niceToHave: { found: niceToHaveFound, total: niceToHaveTotal, rate: niceToHaveTotal > 0 ? niceToHaveFound / niceToHaveTotal : 1 },
    },
    degradedRate: {
      ...degradedCounts,
      total: degradedTotal,
      rate: totalRequests > 0 ? degradedTotal / totalRequests : 0,
    },
  };
}

export function evaluateRecall(
  fixture: FixtureSample,
  group: "B" | "C" | "D",
  compressedOutput: string | null,
  retrieveHits: RetrieveHit[],
  fetchContent: string | null,
): RecallResult {
  const mustHit = fixture.goldenFacts.mustHit;
  const niceToHave = fixture.goldenFacts.niceToHave;

  const searchableText = [
    compressedOutput ?? "",
    ...retrieveHits.map(h => h.snippet),
    fetchContent ?? "",
  ].join("\n");

  const mustHitFound = mustHit.filter(fact => searchableText.includes(fact)).length;
  const niceToHaveFound = niceToHave.filter(fact => searchableText.includes(fact)).length;

  const hits = mustHit.filter(fact => searchableText.includes(fact));
  const misses = mustHit.filter(fact => !searchableText.includes(fact));

  return {
    fixture: fixture.name,
    group,
    hits,
    misses,
    mustHitTotal: mustHit.length,
    mustHitFound,
    niceToHaveTotal: niceToHave.length,
    niceToHaveFound,
  };
}

export function buildPerFixtureRecord(
  fixture: FixtureSample,
  group: "A" | "B" | "C" | "D",
  rawText: string,
  outputText: string,
  latencyMs: number,
  recallHits: string[],
  recallMisses: string[],
  degradedReason: keyof DegradedCounts | null,
): PerFixtureRecord {
  return {
    fixture: fixture.name,
    group,
    rawTokens: countTokens(rawText),
    outTokens: countTokens(outputText),
    latencyMs,
    recallHits,
    recallMisses,
    degradedReason,
  };
}

export function aggregateReport(
  perFixture: PerFixtureRecord[],
  latencies: LatencySample[],
  recallResults: RecallResult[],
): FullReport {
  const groups: ("A" | "B" | "C" | "D")[] = ["A", "B", "C", "D"];
  const groupsMetrics: Record<"A" | "B" | "C" | "D", GroupMetrics> = {} as any;

  for (const g of groups) {
    groupsMetrics[g] = computeGroupMetrics(g, perFixture, latencies, recallResults);
  }

  return {
    meta: {
      timestamp: new Date().toISOString(),
      tokenCounter: "o200k_base",
      versions: { node: process.version, bun: Bun.version },
    },
    groups: groupsMetrics,
    perFixture,
  };
}

export function dispose(): void {
  tokenCounter.dispose();
}