/** Exact-token and correctness metrics for the real A/B/C/D pipelines. */
import { createExactTokenCounter } from "@bluecode/shared"
import type { FixtureSample } from "./fixtures"

export type EvalGroup = "A" | "B" | "C" | "D"

export interface LatencySample {
  group: EvalGroup
  fixture: string
  latencyMs: number
}

export interface FactRecallResult {
  hits: string[]
  misses: string[]
  mustHitTotal: number
  mustHitFound: number
  niceToHaveTotal: number
  niceToHaveFound: number
}

export interface RecallResult {
  fixture: string
  group: EvalGroup
  /** Facts still present in the final model-visible context. */
  context: FactRecallResult
  /** Facts found by BM25 queries alone; null when no archive was queried. */
  query: FactRecallResult | null
  /** Archived objects recovered through session/history-scoped retrieval. */
  archiveRecovery: { found: number; total: number }
}

export interface DegradedCounts {
  spawn_failed: number
  timeout: number
  crash: number
  protocol: number
  no_gain: number
}

interface RecallAggregate {
  mustHit: { found: number; total: number; rate: number }
  niceToHave: { found: number; total: number; rate: number }
}

export interface GroupMetrics {
  compressionRatio: number
  longOutputRatio: number
  latencyP50Ms: number
  latencyP95Ms: number
  contextRecall: RecallAggregate
  queryRecall: RecallAggregate
  archiveRecovery: { found: number; total: number; rate: number }
  degradedRate: DegradedCounts & { total: number; rate: number }
}

export interface PerFixtureRecord {
  fixture: string
  group: EvalGroup
  rawTokens: number
  outTokens: number
  latencyMs: number
  contextRecallHits: string[]
  contextRecallMisses: string[]
  queryRecallHits: string[]
  queryRecallMisses: string[]
  archiveRecoveryFound: number
  archiveRecoveryTotal: number
  degradedReason: keyof DegradedCounts | null
}

export interface FullReport {
  meta: {
    timestamp: string
    tokenCounter: "o200k_base"
    versions: { node: string; bun: string }
  }
  groups: Record<EvalGroup, GroupMetrics>
  perFixture: PerFixtureRecord[]
}

const tokenCounter = createExactTokenCounter()
const LONG_OUTPUT_THRESHOLD = 10240

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)] ?? 0
}

function countTokens(text: string): number {
  return tokenCounter.count(text)
}

export function computeCompressionRatio(rawTokens: number, outTokens: number): number {
  if (rawTokens === 0) return 1
  return outTokens / rawTokens
}

function aggregateRecall(results: FactRecallResult[]): RecallAggregate {
  const mustHitTotal = results.reduce((sum, result) => sum + result.mustHitTotal, 0)
  const mustHitFound = results.reduce((sum, result) => sum + result.mustHitFound, 0)
  const niceToHaveTotal = results.reduce((sum, result) => sum + result.niceToHaveTotal, 0)
  const niceToHaveFound = results.reduce((sum, result) => sum + result.niceToHaveFound, 0)
  return {
    mustHit: {
      found: mustHitFound,
      total: mustHitTotal,
      rate: mustHitTotal > 0 ? mustHitFound / mustHitTotal : 1,
    },
    niceToHave: {
      found: niceToHaveFound,
      total: niceToHaveTotal,
      rate: niceToHaveTotal > 0 ? niceToHaveFound / niceToHaveTotal : 1,
    },
  }
}

export function computeGroupMetrics(
  group: EvalGroup,
  perFixture: PerFixtureRecord[],
  latencies: LatencySample[],
  recallResults: RecallResult[],
): GroupMetrics {
  const groupFixtures = perFixture.filter((fixture) => fixture.group === group)
  const groupLatencies = latencies
    .filter((sample) => sample.group === group)
    .map((sample) => sample.latencyMs)
    .sort((a, b) => a - b)
  const groupRecalls = recallResults.filter((result) => result.group === group)

  const totalRaw = groupFixtures.reduce((sum, fixture) => sum + fixture.rawTokens, 0)
  const totalOut = groupFixtures.reduce((sum, fixture) => sum + fixture.outTokens, 0)
  const longFixtures = groupFixtures.filter(
    (fixture) => fixture.rawTokens * 4 > LONG_OUTPUT_THRESHOLD,
  )
  const longRaw = longFixtures.reduce((sum, fixture) => sum + fixture.rawTokens, 0)
  const longOut = longFixtures.reduce((sum, fixture) => sum + fixture.outTokens, 0)

  const archiveFound = groupRecalls.reduce(
    (sum, result) => sum + result.archiveRecovery.found,
    0,
  )
  const archiveTotal = groupRecalls.reduce(
    (sum, result) => sum + result.archiveRecovery.total,
    0,
  )

  const degradedCounts: DegradedCounts = {
    spawn_failed: 0,
    timeout: 0,
    crash: 0,
    protocol: 0,
    no_gain: 0,
  }
  for (const fixture of groupFixtures) {
    if (fixture.degradedReason !== null) degradedCounts[fixture.degradedReason]++
  }
  const degradedTotal = Object.values(degradedCounts).reduce((sum, count) => sum + count, 0)

  return {
    compressionRatio: computeCompressionRatio(totalRaw, totalOut),
    longOutputRatio: computeCompressionRatio(longRaw, longOut),
    latencyP50Ms: percentile(groupLatencies, 50),
    latencyP95Ms: percentile(groupLatencies, 95),
    contextRecall: aggregateRecall(groupRecalls.map((result) => result.context)),
    queryRecall: aggregateRecall(
      groupRecalls.flatMap((result) => result.query === null ? [] : [result.query]),
    ),
    archiveRecovery: {
      found: archiveFound,
      total: archiveTotal,
      rate: archiveTotal > 0 ? archiveFound / archiveTotal : 1,
    },
    degradedRate: {
      ...degradedCounts,
      total: degradedTotal,
      rate: groupFixtures.length > 0 ? degradedTotal / groupFixtures.length : 0,
    },
  }
}

function matchFacts(fixture: FixtureSample, includes: (fact: string) => boolean): FactRecallResult {
  const mustHit = fixture.goldenFacts.mustHit
  const niceToHave = fixture.goldenFacts.niceToHave
  const hits = mustHit.filter(includes)
  return {
    hits,
    misses: mustHit.filter((fact) => !includes(fact)),
    mustHitTotal: mustHit.length,
    mustHitFound: hits.length,
    niceToHaveTotal: niceToHave.length,
    niceToHaveFound: niceToHave.filter(includes).length,
  }
}

export function evaluateRecall(
  fixture: FixtureSample,
  group: EvalGroup,
  activeContext: string | null,
  queryMatches: string[] | null,
  archiveRecovery: { found: number; total: number },
): RecallResult {
  const contextText = activeContext ?? ""
  const querySet = queryMatches === null ? null : new Set(queryMatches)
  return {
    fixture: fixture.name,
    group,
    context: matchFacts(fixture, (fact) => contextText.includes(fact)),
    query: querySet === null ? null : matchFacts(fixture, (fact) => querySet.has(fact)),
    archiveRecovery,
  }
}

export function buildPerFixtureRecord(
  fixture: FixtureSample,
  group: EvalGroup,
  rawText: string,
  outputText: string,
  latencyMs: number,
  recall: RecallResult,
  degradedReason: keyof DegradedCounts | null,
): PerFixtureRecord {
  return {
    fixture: fixture.name,
    group,
    rawTokens: countTokens(rawText),
    outTokens: countTokens(outputText),
    latencyMs,
    contextRecallHits: recall.context.hits,
    contextRecallMisses: recall.context.misses,
    queryRecallHits: recall.query?.hits ?? [],
    queryRecallMisses: recall.query?.misses ?? [],
    archiveRecoveryFound: recall.archiveRecovery.found,
    archiveRecoveryTotal: recall.archiveRecovery.total,
    degradedReason,
  }
}

export function aggregateReport(
  perFixture: PerFixtureRecord[],
  latencies: LatencySample[],
  recallResults: RecallResult[],
): FullReport {
  const groups = {} as Record<EvalGroup, GroupMetrics>
  for (const group of ["A", "B", "C", "D"] as const) {
    groups[group] = computeGroupMetrics(group, perFixture, latencies, recallResults)
  }
  return {
    meta: {
      timestamp: new Date().toISOString(),
      tokenCounter: "o200k_base",
      versions: { node: process.version, bun: Bun.version },
    },
    groups,
    perFixture,
  }
}

export function dispose(): void {
  tokenCounter.dispose()
}
