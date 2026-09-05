/**
 * test strategy — failure cases preserved verbatim.
 *
 * Failure blocks (FAIL/✗/✖/--- FAIL:/assertion diffs/error stacks) are
 * detected by seed + continuation expansion and kept as anchors; inside a
 * block, assertion diff lines (Expected/Received) rank highest. Passed-case
 * runs collapse into "✓ N passed (elided)" markers grouped by suite; summary
 * lines (Tests:/Test Suites:/Time) stay as anchors.
 */
import { PRI } from "../anchor"
import { splitLines, type CLine, type Strategy, type StrategyResult } from "./types"

/** Lines that start (seed) or continue a failure block. */
const SEED_RE =
  /^\s*FAIL\b|^\d+\)\s|[✗✖●]|^--- FAIL:|(?:AssertionError|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError)\b|^\s*[\w$.]*(?:Error|Exception):\s|^expect\(.*\)|^Expected:? |^Received:? |^\s*(?:Expected|Received):?\s/

/**
 * Continuation shape: indented detail (stack frames, code frames, messages),
 * +/- assertion diffs, Expected/Received lines, failure marks. Passing-case
 * lines (leading ✓/✔ after indent) never continue a failure block.
 */
function isContinuation(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === "") return false
  if (/[✗✖●]/.test(line)) return true
  if (trimmed.startsWith("✓") || trimmed.startsWith("✔") || /^(?:--- PASS:|PASS\s)/.test(line))
    return false
  if (/^[ \t]/.test(line)) return true // indented detail / stack / code frames
  if (/^[+\-]/.test(line)) return true // assertion diff lines
  return /^Expected|^Received/.test(trimmed)
}

const PASS_RE = /^\s*[✓✔]|^--- PASS:/
const SUITE_HEADER_RE = /^(?:PASS|FAILED?)\s+(\S+)/
const SUITE_FILE_RE = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):/
const SUMMARY_RE = /^(?:Tests?:|Test Suites?:|Snapshots?:|Time:|Ran all test suites\.)/

export const testStrategy: Strategy = ({ text }) => {
  const lines = splitLines(text)
  const notes: string[] = []

  // Single forward pass: failure blocks union naturally, even with many seeds.
  const inBlock = new Array<boolean>(lines.length).fill(false)
  let blockCount = 0
  let active = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const seed = SEED_RE.test(line)
    if (seed) {
      if (!active) blockCount++
      active = true
      for (let back = Math.max(0, i - 2); back < i; back++) {
        if (isContinuation(lines[back] ?? "")) inBlock[back] = true
      }
    }
    // A checkmark may be assertion snapshot data. Only explicit runner headers
    // end a failure region; ambiguous following detail remains protected.
    if (active && /^(?:--- PASS:|PASS\s)/.test(line)) active = false
    if (active) inBlock[i] = true
  }

  // Pass 2: emit in original order, folding passed-case runs per suite.
  const out: CLine[] = []
  let suite = "tests"
  let failLinesKept = 0
  let passRunsFolded = 0
  let passCasesFolded = 0

  const foldRun = (count: number): void => {
    if (count <= 0) return
    passRunsFolded++
    passCasesFolded += count
    out.push({
      text: `✓ ${count} passed (elided)`,
      anchor: false,
      priority: PRI.low,
      group: suite,
    })
  }

  let pendingPass = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    if (inBlock[i]) {
      foldRun(pendingPass)
      pendingPass = 0
      out.push({
        text: line,
        sourceLine: i + 1,
        anchor: true,
        priority: PRI.critical,
        group: suite,
      })
      failLinesKept++
      continue
    }

    const suiteHeader = SUITE_HEADER_RE.exec(line)
    if (suiteHeader !== null) {
      foldRun(pendingPass)
      pendingPass = 0
      suite = suiteHeader[1] ?? suite
      out.push({ text: line, sourceLine: i + 1, anchor: true, priority: PRI.high, group: suite })
      continue
    }
    const suiteFile = SUITE_FILE_RE.exec(line)
    if (suiteFile !== null) {
      foldRun(pendingPass)
      pendingPass = 0
      suite = suiteFile[1] ?? suite
    }

    if (SUMMARY_RE.test(line)) {
      foldRun(pendingPass)
      pendingPass = 0
      out.push({
        text: line,
        sourceLine: i + 1,
        anchor: true,
        priority: PRI.critical,
        group: "summary",
      })
      continue
    }

    if (!inBlock[i] && PASS_RE.test(line)) {
      pendingPass++
      continue
    }

    if (line.trim() === "") {
      // Blanks break pass-runs but are kept (low priority) to preserve layout.
      foldRun(pendingPass)
      pendingPass = 0
      out.push({ text: "", sourceLine: i + 1, anchor: false, priority: PRI.low, group: "other" })
      continue
    }

    foldRun(pendingPass)
    pendingPass = 0
    out.push({ text: line, sourceLine: i + 1, anchor: true, priority: PRI.normal, group: "other" })
  }
  foldRun(pendingPass)

  notes.push(
    `test: kept ${failLinesKept} failure line(s) across ${blockCount} block(s); folded ${passCasesFolded} passed case(s) into ${passRunsFolded} run marker(s)`
  )
  return { lines: out, strategy: "test", notes }
}
