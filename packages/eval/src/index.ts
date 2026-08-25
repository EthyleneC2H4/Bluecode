/**
 * @bluecode/eval — Offline deterministic evaluation harness.
 *
 * Exports:
 * - Fixtures: buildFixtures, allFixtures, quickFixtures, fixturesToHeadroomParams
 * - Metrics: computeGroupMetrics, evaluateRecall, aggregateReport
 * - Runner: runEvaluation
 * - Report: writeReport, readReport, printSummary
 * - Check-baseline: checkBaseline
 * - CLI: main entry point via cli.ts
 */
export * from "./fixtures";
export { computeGroupMetrics, evaluateRecall, aggregateReport, dispose as disposeMetrics } from "./metrics";
export * from "./runner";
export { writeReport, readReport, printSummary, dispose as disposeReport } from "./report";
export * from "./check-baseline";

export const VERSION = "0.1.0" as const;