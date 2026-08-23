/**
 * Token-budget trimming.
 *
 * Elidable lines are trimmed lowest-priority-first until the assembled text
 * fits the budget; trimmed lines aggregate into per-group summary lines that
 * count against the budget. Anchor lines are never trimmed — if anchors alone
 * exceed the budget the result honestly exceeds it too (no silent content
 * loss). A retrieval hint footer is always appended.
 */
import { estimateTokens } from "@bluecode/shared";
import type { CLine } from "./strategies/types";

export interface BudgetOptions {
  /** Maximum estimateTokens for the returned text (footer included). */
  budgetTokens: number;
  /** Full hash reference ("sha256:<hex>"), interpolated verbatim into hints. */
  rawHash: string;
  rawTokensEst: number;
  /** Tool id; fallback group label for lines without an explicit group. */
  tool: string;
}

export interface BudgetResult {
  text: string;
  /** estimateTokens of the trimmed line bodies (excludes summaries/footer). */
  elidedTokens: number;
  /** Distinct groups that lost at least one line. */
  groupsCollapsed: number;
}

/** Per-line token cost including its newline; deliberately over-estimates. */
function lineCost(text: string): number {
  return estimateTokens(text) + 1;
}

export function applyBudget(lines: CLine[], opts: BudgetOptions): BudgetResult {
  const groupLabel = (cl: CLine): string => cl.group ?? opts.tool;

  // Trim candidates: elidables only, cheapest-priority first (stable ties).
  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cl = lines[i];
    if (cl !== undefined && !cl.anchor) candidates.push(i);
  }
  candidates.sort((a, b) => {
    const pa = lines[a]?.priority ?? 0;
    const pb = lines[b]?.priority ?? 0;
    return pa - pb || a - b;
  });

  const footerReserve =
    lineCost(
      `[bluecode rtk] compressed: rawHash=${opts.rawHash} (0 tokens elided). Full output: headroom_retrieve(hash="${opts.rawHash}")`,
    ) + 4;

  const removed = new Set<number>();
  let keptCostUpper = 0;
  for (const cl of lines) keptCostUpper += lineCost(cl.text);

  let ci = 0;
  // Coarse pass using the per-line upper bound; exact check happens below.
  while (
    ci < candidates.length &&
    keptCostUpper + footerReserve > opts.budgetTokens
  ) {
    const idx = candidates[ci];
    if (idx === undefined) break;
    const cl = lines[idx];
    if (cl === undefined) break;
    keptCostUpper -= lineCost(cl.text);
    removed.add(idx);
    ci++;
  }

  const groupOf = (i: number): string => {
    const cl = lines[i];
    return groupLabel(cl ?? { text: "", anchor: false, priority: 0 });
  };

  const assemble = (): string => {
    const parts: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (!removed.has(i)) {
        const cl = lines[i];
        if (cl !== undefined) parts.push(cl.text);
        i++;
        continue;
      }
      // Maximal run of removed lines sharing one group label -> one summary.
      const label = groupOf(i);
      let count = 0;
      while (i < lines.length && removed.has(i) && groupOf(i) === label) {
        count++;
        i++;
      }
      parts.push(`[+${count} line${count === 1 ? "" : "s"} elided in ${label}]`);
    }
    return parts.join("\n");
  };

  // Exact phase: rebuild (footer included) until the real estimate fits or
  // nothing is left to trim — anchors-only honest degradation.
  let elidedTokens = 0;
  let text = "";
  for (;;) {
    elidedTokens = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!removed.has(i)) continue;
      const cl = lines[i];
      if (cl === undefined) continue;
      elidedTokens += lineCost(cl.text);
    }
    const footer = `[bluecode rtk] compressed: rawHash=${opts.rawHash} (${elidedTokens} tokens elided). Full output: headroom_retrieve(hash="${opts.rawHash}")`;
    text = `${assemble()}\n${footer}`;
    if (estimateTokens(text) <= opts.budgetTokens) break;
    if (ci >= candidates.length) break;
    const idx = candidates[ci];
    if (idx === undefined) break;
    removed.add(idx);
    ci++;
  }

  const collapsedGroups = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!removed.has(i)) continue;
    const cl = lines[i];
    if (cl === undefined) continue;
    collapsedGroups.add(groupLabel(cl));
  }

  return { text, elidedTokens, groupsCollapsed: collapsedGroups.size };
}
