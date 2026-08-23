/**
 * Core data model shared by every strategy and the whole pipeline.
 *
 * A strategy NEVER makes token-budget decisions: it only classifies the raw
 * text into CLine entries (shape-level folding like "[+N in dir]" is part of
 * describing the shape, not budgeting). All trimming happens in budget.ts.
 */
import type { StrategyName } from "@bluecode/contracts";

/** One classified output line flowing through the pipeline. */
export interface CLine {
  text: string;
  /** true = never trimmed (paths / line numbers / hunk heads / error anchors). */
  anchor: boolean;
  /** Higher = trimmed later; ignored for anchor lines. */
  priority: number;
  /** Owning group (file / dir / test suite); trim summaries aggregate per group. */
  group?: string | undefined;
}

export interface StrategyResult {
  lines: CLine[];
  strategy: StrategyName;
  /** Human-readable processing notes; surfaced via pipeline metadata. */
  notes: string[];
}

export interface StrategyInput {
  /** Raw (already sanitized + redacted) tool output text. */
  text: string;
  /** Tool id that produced the output (e.g. "bash", "grep"). */
  toolId: string;
}

export type Strategy = (input: StrategyInput) => StrategyResult;

/**
 * Split into lines, dropping only the single trailing empty element that
 * comes from a trailing newline (real blank lines are preserved).
 */
export function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
