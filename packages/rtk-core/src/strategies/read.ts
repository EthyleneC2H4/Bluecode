/**
 * read strategy — line-number anchors and middle folding.
 *
 * opencode read prints "  <n>\t<content>". The first and last 20 numbered
 * lines are kept verbatim as anchors; the middle folds into a single
 * "[read] lines X-Y elided (Z lines ...)" marker. Inputs without line numbers
 * fall back to the unknown strategy (noted), never silently transformed.
 */
import { PRI } from "../anchor";
import { splitLines, type CLine, type Strategy, type StrategyResult } from "./types";
import { fallbackStrategy } from "./fallback";

const NUM_RE = /^(\s*)(\d+)[\t ](.*)$/;
const KEEP_HEAD = 20;
const KEEP_TAIL = 20;

export const readStrategy: Strategy = ({ text }) => {
  const lines = splitLines(text);
  const nonEmpty = lines.filter((l) => l.trim() !== "");

  let numberedCount = 0;
  const nums: number[] = [];
  for (const line of nonEmpty) {
    const m = NUM_RE.exec(line);
    if (m !== null) {
      numberedCount++;
      nums.push(Number(m[2]));
    }
  }

  // No recognizable line numbers -> hand over to the unknown fallback.
  if (nonEmpty.length === 0 || numberedCount / nonEmpty.length < 0.5) {
    const fb = fallbackStrategy({ text, toolId: "read" });
    return {
      lines: fb.lines,
      strategy: "unknown",
      notes: [
        "read: input lacks line-number format; fell back to unknown strategy",
        ...fb.notes,
      ],
    };
  }

  const notes: string[] = [];
  const out: CLine[] = [];
  const total = nums.length;
  const headEnd = Math.min(KEEP_HEAD, total);
  const tailStart = Math.max(headEnd, total - KEEP_TAIL);

  let position = 0; // index among numbered lines
  let middleEmitted = false;

  for (const line of lines) {
    if (!NUM_RE.test(line)) {
      out.push({
        text: line,
        anchor: false,
        priority: line.trim() === "" ? PRI.low : PRI.normal,
        group: "other",
      });
      continue;
    }

    if (position >= headEnd && position < tailStart) {
      if (!middleEmitted) {
        const count = tailStart - headEnd;
        const firstMid = nums[headEnd] ?? count;
        const lastMid = nums[tailStart - 1] ?? tailStart;
        out.push({
          text: `[read] lines ${firstMid}–${lastMid} elided (${count} lines, rawHash in footer)`,
          anchor: false,
          priority: PRI.low,
          group: "read-middle",
        });
        middleEmitted = true;
      }
      position++;
      continue;
    }

    out.push({ text: line, anchor: true, priority: PRI.critical, group: "read" });
    position++;
  }

  const folded = tailStart - headEnd;
  notes.push(
    folded > 0
      ? `read: kept ${headEnd}+${total - tailStart} head/tail of ${total} numbered line(s); folded ${folded}`
      : `read: ${total} numbered line(s), nothing to fold`,
  );
  return { lines: out, strategy: "read", notes };
};
