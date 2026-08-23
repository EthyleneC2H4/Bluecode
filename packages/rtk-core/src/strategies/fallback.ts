/**
 * unknown fallback — never loses unrecognized content.
 *
 * Exactly two transformations:
 * 1. runs of consecutive fully-duplicate lines collapse to `<line> ×N`
 * 2. runs of blank lines collapse to a single blank line
 * Everything else is kept verbatim as elidable lines so budget trimming can
 * still reclaim tokens while always leaving a per-group summary behind.
 */
import { PRI } from "../anchor";
import { splitLines, type CLine, type Strategy, type StrategyResult } from "./types";

export const fallbackStrategy: Strategy = ({ text }) => {
  const lines = splitLines(text);
  const out: CLine[] = [];
  const notes: string[] = [];

  let dupRuns = 0;
  let dupLinesRemoved = 0;
  let blankRuns = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break; // unreachable; satisfies noUncheckedIndexedAccess

    if (line.trim() === "") {
      let j = i;
      while (j < lines.length && lines[j]?.trim() === "") j++;
      if (j - i > 1) blankRuns++;
      out.push({ text: "", anchor: false, priority: PRI.low, group: "output" });
      i = j;
      continue;
    }

    let j = i;
    while (j < lines.length && lines[j] === line) j++;
    const run = j - i;
    if (run > 1) {
      dupRuns++;
      dupLinesRemoved += run - 1;
      out.push({ text: `${line} ×${run}`, anchor: false, priority: PRI.normal, group: "output" });
    } else {
      out.push({ text: line, anchor: false, priority: PRI.normal, group: "output" });
    }
    i = j;
  }

  if (dupRuns > 0) notes.push(`collapsed ${dupRuns} duplicate run(s) (${dupLinesRemoved} line(s) removed)`);
  if (blankRuns > 0) notes.push(`collapsed ${blankRuns} blank run(s)`);
  if (notes.length === 0) notes.push("no duplicate or blank runs found");

  return { lines: out, strategy: "unknown", notes };
};
