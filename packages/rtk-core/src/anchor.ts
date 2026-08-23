/**
 * Line anchor model: partition + cross-strategy priority constants.
 */
import type { CLine } from "./strategies/types";

/**
 * Trim priority constants (higher = trimmed later; anchor lines ignore this).
 * Strategies must reference these instead of magic numbers so that relative
 * ordering stays consistent across strategies.
 */
export const PRI = { critical: 100, high: 70, normal: 40, low: 10 } as const;

export interface Partition {
  /** Lines that must survive any budget. */
  anchors: CLine[];
  /** Trim candidates, sorted by priority descending (most precious first). */
  elidable: CLine[];
}

/** Split lines into anchors and elidables; elidables come back priority-desc. */
export function partition(lines: CLine[]): Partition {
  const anchors: CLine[] = [];
  const elidable: CLine[] = [];
  for (const line of lines) (line.anchor ? anchors : elidable).push(line);
  // Array#sort is stable (ES2019+), so equal priorities keep input order.
  elidable.sort((a, b) => b.priority - a.priority);
  return { anchors, elidable };
}
