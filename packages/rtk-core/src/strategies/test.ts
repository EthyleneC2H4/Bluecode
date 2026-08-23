/**
 * test strategy — failure cases preserved verbatim.
 *
 * Failure blocks (FAIL/✗/✖/--- FAIL:/assertion diffs/error stacks) are
 * detected by seed + continuation expansion and kept as anchors; inside a
 * block, assertion diff lines (Expected/Received) rank highest. Passed-case
 * runs collapse into "✓ N passed (elided)" markers grouped by suite; summary
 * lines (Tests:/Test Suites:/Time) stay as anchors.
 */
import { PRI } from "../anchor";
import { splitLines, type CLine, type Strategy, type StrategyResult } from "./types";

/** Lines that start (seed) or continue a failure block. */
const SEED_RE =
  /^\s*FAIL\b|^\d+\)\s|[✗✖●]|^--- FAIL:|(?:AssertionError|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError)\b|^\s*[\w$.]*(?:Error|Exception):\s|^expect\(.*\)|^Expected:? |^Received:? |^\s*(?:Expected|Received):?\s/;

/**
 * Continuation shape: indented detail (stack frames, code frames, messages),
 * +/- assertion diffs, Expected/Received lines, failure marks. Passing-case
 * lines (leading ✓/✔ after indent) never continue a failure block.
 */
function isContinuation(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (/[✗✖●]/.test(line)) return true;
  if (trimmed.startsWith("✓") || trimmed.startsWith("✔")) return false;
  if (/^[ \t]/.test(line)) return true; // indented detail / stack / code frames
  if (/^[+\-]/.test(line)) return true; // assertion diff lines
  return /^Expected|^Received/.test(trimmed);
}

const PASS_RE = /[✓✔]/;
const SUITE_HEADER_RE = /^(?:PASS|FAILED?)\s+(\S+)/;
const SUITE_FILE_RE = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):/;
const SUMMARY_RE =
  /^(?:Tests?:|Test Suites?:|Snapshots?:|Time:|Ran all test suites\.)/;

export const testStrategy: Strategy = ({ text }) => {
  const lines = splitLines(text);
  const notes: string[] = [];

  // Pass 1: expand failure blocks from seeds.
  const inBlock = new Array<boolean>(lines.length).fill(false);
  let blockCount = 0;
  for (let s = 0; s < lines.length; s++) {
    const seed = lines[s];
    if (seed === undefined || !SEED_RE.test(seed)) continue;
    blockCount++;
    // Walk backward over up to 2 continuation-shaped context lines.
    for (
      let b = s - 1, steps = 0;
      b >= 0 && steps < 2 && inBlock[b] === false;
      b--, steps++
    ) {
      const prev = lines[b];
      if (prev === undefined || prev.trim() === "" || !isContinuation(prev)) break;
      inBlock[b] = true;
    }
    // Walk forward while lines look like failure-block content.
    for (let i = s; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) break;
      inBlock[i] = true;
      if (SEED_RE.test(line)) continue;
      if (isContinuation(line)) continue;
      if (line.trim() === "") {
        // A blank continues the block only if the next line still looks like it.
        const next = lines[i + 1];
        if (next !== undefined && (isContinuation(next) || SEED_RE.test(next))) continue;
        break;
      }
      break;
    }
  }

  // Pass 2: emit in original order, folding passed-case runs per suite.
  const out: CLine[] = [];
  let suite = "tests";
  let failLinesKept = 0;
  let passRunsFolded = 0;
  let passCasesFolded = 0;

  const foldRun = (count: number): void => {
    if (count <= 0) return;
    passRunsFolded++;
    passCasesFolded += count;
    out.push({
      text: `✓ ${count} passed (elided)`,
      anchor: false,
      priority: PRI.low,
      group: suite,
    });
  };

  let pendingPass = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    if (inBlock[i]) {
      foldRun(pendingPass);
      pendingPass = 0;
      out.push({ text: line, anchor: true, priority: PRI.critical, group: suite });
      failLinesKept++;
      continue;
    }

    const suiteHeader = SUITE_HEADER_RE.exec(line);
    if (suiteHeader !== null) {
      foldRun(pendingPass);
      pendingPass = 0;
      suite = suiteHeader[1] ?? suite;
      out.push({ text: line, anchor: true, priority: PRI.high, group: suite });
      continue;
    }
    const suiteFile = SUITE_FILE_RE.exec(line);
    if (suiteFile !== null) {
      foldRun(pendingPass);
      pendingPass = 0;
      suite = suiteFile[1] ?? suite;
    }

    if (SUMMARY_RE.test(line)) {
      foldRun(pendingPass);
      pendingPass = 0;
      out.push({ text: line, anchor: true, priority: PRI.critical, group: "summary" });
      continue;
    }

    if (!inBlock[i] && PASS_RE.test(line)) {
      pendingPass++;
      continue;
    }

    if (line.trim() === "") {
      // Blanks break pass-runs but are kept (low priority) to preserve layout.
      foldRun(pendingPass);
      pendingPass = 0;
      out.push({ text: "", anchor: false, priority: PRI.low, group: "other" });
      continue;
    }

    foldRun(pendingPass);
    pendingPass = 0;
    out.push({ text: line, anchor: false, priority: PRI.normal, group: "other" });
  }
  foldRun(pendingPass);

  notes.push(
    `test: kept ${failLinesKept} failure line(s) across ${blockCount} block(s); folded ${passCasesFolded} passed case(s) into ${passRunsFolded} run marker(s)`,
  );
  return { lines: out, strategy: "test", notes };
};
