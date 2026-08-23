/**
 * @bluecode/rtk-core — pure-function tool-output compression pipeline.
 *
 * Public surface is deliberately minimal: the pipeline entry point, the
 * pipeline stats counter factory, and their types. Everything else
 * (classifier, strategies, budgeting, anchor model) is internal detail.
 */
export {
  compressToolOutput,
  type CompressToolOutputInput,
  type CompressToolOutputResult,
} from "./pipeline";
export { createPipelineStats, type PipelineStatsSnapshot } from "./stats";
export type { CLine, Strategy, StrategyInput, StrategyResult } from "./strategies/types";
export type { Classification } from "./classify";
