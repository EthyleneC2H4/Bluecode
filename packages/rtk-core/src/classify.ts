/**
 * Strategy classification for tool outputs.
 *
 * Two tiers:
 * 1. explicit tool-id mapping (primary signal, confidence 1.0):
 *    read->read; grep->grep; glob/ls->ls; bash and everything else fall
 *    through to feature scoring.
 * 2. feature scoring (secondary evidence, each 0..1). The best score wins if
 *    it reaches 0.6; otherwise the output falls back to the "unknown"
 *    strategy (fallback.ts), which never discards content.
 */
import type { StrategyName } from "@bluecode/contracts"

export interface Classification {
  strategy: StrategyName
  /** 0..1; 1.0 only for explicit tool-id mapping. */
  confidence: number
  /** Human-readable evidence strings; surfaced via pipeline notes. */
  signals: string[]
}

/** Explicit tool id -> strategy (primary signal). */
const TOOL_STRATEGY: Record<string, StrategyName> = {
  read: "read",
  grep: "grep",
  glob: "ls",
  ls: "ls",
}

const CONFIDENCE_THRESHOLD = 0.6

export function classify(tool: string, output: string): Classification {
  // Guard against prototype pollution: Object.prototype properties
  // (toString, constructor, valueOf, hasOwnProperty, __proto__) must not
  // match explicit tool mappings. Use hasOwnProperty check.
  if (Object.prototype.hasOwnProperty.call(TOOL_STRATEGY, tool)) {
    // hasOwnProperty narrows the type, but TS doesn't know that — cast is safe.
    const mapped = TOOL_STRATEGY[tool] as StrategyName
    return { strategy: mapped, confidence: 1, signals: [`tool_id:${tool} -> ${mapped}`] }
  }
  return classifyByFeatures(tool, output)
}

// ---------------------------------------------------------------------------
// feature scoring
// ---------------------------------------------------------------------------

interface FeatureScore {
  name: Exclude<StrategyName, "unknown">
  score: number
  signal: string
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** A path that could plausibly appear in grep/listing output. */
function pathLike(p: string): boolean {
  if (p === "" || /\s/.test(p)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return false // URL scheme guard
  return /[\\/]/.test(p) || /\.[A-Za-z0-9]{1,8}$/.test(p)
}

/**
 * `path:line:text` plus tolerant `-` separators on either side (context
 * lines) and an optional content part (`path:line` variant).
 */
const GREP_LINE_RE = /^([^\s:][^\s]*?)[:-](\d+)(?:[:-](.*))?$/

export function parseGrepLine(line: string): { path: string; lineNo: number; text: string } | null {
  const m = GREP_LINE_RE.exec(line)
  if (m === null) return null
  const path = m[1] ?? ""
  if (!pathLike(path)) return null
  return { path, lineNo: Number(m[2]), text: m[3] ?? "" }
}

const LS_PERM_RE = /^[dcb\-l][rwxStTs\-]{9}[@.+]*\s/
const LS_PATH_LINE_RE =
  /^(?:\.{1,2}\/|~\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\/?$|^[\w.@+-]+\/$|^\.{1,2}\/[\w.@+-]+$/
const LS_TOTAL_RE = /^total \d+$/

const TEST_CHECK_RE = /[✓✔]/
const TEST_FAIL_MARK_RE = /[✗✖●]/
const TEST_PF_RE = /^(?:PASS|FAILED?)\b|^--- (?:FAIL|PASS):|^ok\b/
const TEST_AT_RE = /^\s+at\s/
const TEST_SUMMARY_RE = /(?:^|\s)(?:Tests?|Test Suites?):/

const READ_NUM_RE = /^\s*\d+(?::(?: |$)|[\t ])/

function classifyByFeatures(tool: string, output: string): Classification {
  const lines = output.split("\n").filter((l) => l.trim() !== "")
  const total = lines.length

  const scores: FeatureScore[] = []

  // --- diff ---------------------------------------------------------------
  if (total > 0) {
    let diffGit = 0
    let hunk = 0
    let pm = 0
    for (const line of lines) {
      if (line.startsWith("diff --git ")) diffGit++
      else if (/^@@ .+ @@/.test(line) || /^@@@ .+ @@@/.test(line)) hunk++
      // Test-runner "--- PASS/FAIL:" headers are not diff file headers.
      else if (/^--- (?:FAIL|PASS):/.test(line)) continue
      else if (line.startsWith("+++ ") || line.startsWith("--- ")) pm++
    }
    scores.push({
      name: "diff",
      score: clamp01(((diffGit * 2 + hunk * 1.5 + pm * 0.5) / total) * 4),
      signal: `diff: ${diffGit} 'diff --git', ${hunk} hunk header(s), ${pm} +++/--- line(s) of ${total}`,
    })
  }

  // --- grep ----------------------------------------------------------------
  if (total > 0) {
    let matched = 0
    for (const line of lines) if (parseGrepLine(line) !== null) matched++
    scores.push({
      name: "grep",
      score: matched / total,
      signal: `grep: ${matched}/${total} line(s) match path:line(:text)`,
    })
  }

  // --- ls ------------------------------------------------------------------
  if (total > 0) {
    let perm = 0
    let pathish = 0
    let totals = 0
    for (const line of lines) {
      if (LS_PERM_RE.test(line)) perm++
      else if (LS_PATH_LINE_RE.test(line)) pathish++
      if (LS_TOTAL_RE.test(line)) totals++
    }
    scores.push({
      name: "ls",
      score: clamp01((perm / total) * 1.5 + totals * 0.2 + (pathish / total) * 0.8),
      signal: `ls: ${perm} permission-style, ${pathish} path-like, ${totals} 'total' of ${total}`,
    })
  }

  // --- test ----------------------------------------------------------------
  if (total > 0) {
    let check = 0
    let failMark = 0
    let pf = 0
    let runnerCaseHeader = false
    let frames = 0
    let summary = false
    for (const line of lines) {
      if (TEST_CHECK_RE.test(line)) check++
      if (TEST_FAIL_MARK_RE.test(line)) failMark++
      if (TEST_PF_RE.test(line)) pf++
      if (/^--- (?:FAIL|PASS):/.test(line)) runnerCaseHeader = true
      if (TEST_AT_RE.test(line)) frames++
      if (TEST_SUMMARY_RE.test(line)) summary = true
    }
    const score = clamp01(
      ((check + failMark) / total) * 2 +
        Math.min((pf / total) * 2, 0.5) +
        (runnerCaseHeader ? 0.35 : 0) +
        Math.min((frames / total) * 2, 0.3) +
        (summary ? 0.4 : 0)
    )
    scores.push({
      name: "test",
      score,
      signal: `test: ${check} pass-mark(s), ${failMark} fail-mark(s), ${pf} PASS/FAIL, ${frames} stack frame(s), summary=${summary}`,
    })
  }

  // --- read ----------------------------------------------------------------
  if (total > 0) {
    let numbered = 0
    for (const line of lines) if (READ_NUM_RE.test(line)) numbered++
    scores.push({
      name: "read",
      score: numbered / total,
      signal: `read: ${numbered}/${total} line(s) start with a line number`,
    })
  }

  let best: FeatureScore | undefined
  for (const s of scores) {
    if (best === undefined || s.score > best.score) best = s
  }

  if (best !== undefined && best.score >= CONFIDENCE_THRESHOLD) {
    return { strategy: best.name, confidence: best.score, signals: [best.signal] }
  }

  const top = best === undefined ? "no non-blank lines" : `top=${best.signal}`
  return {
    strategy: "unknown",
    confidence: best?.score ?? 0,
    signals: [`bash/features(${tool}): below ${CONFIDENCE_THRESHOLD} threshold (${top})`],
  }
}
