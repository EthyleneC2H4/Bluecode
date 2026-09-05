/**
 * grep strategy — file:line grouping and range merging.
 *
 * Parses `path:line:text` (also `path:line-text` context lines and the
 * content-less `path:line` variant). Matches are grouped per file, sorted by
 * line number, and near-contiguous runs (gap <= 3) merge into summary lines
 * like "path:1-45 (12 matches)". Each group keeps its first match plus every
 * line carrying an error/warn/fail/exception keyword — both as anchors.
 * Bare path lines (ripgrep heading style) are anchors too.
 */
import { fallbackStrategy } from "./fallback"
import { PRI } from "../anchor"
import { parseGrepLine } from "../classify"
import { splitLines, type CLine, type Strategy, type StrategyResult } from "./types"

const ERROR_KEYWORD_RE = /(error|warn|fail|exception)/i
/** Gap between consecutive match line numbers that still merges into one range. */
const MERGE_GAP = 3

interface Match {
  lineNo: number
  raw: string
  sourceLine: number
}

interface Range {
  start: number
  end: number
  count: number
}

function mergeRanges(matches: Match[]): Range[] {
  const sorted = [...matches].sort((a, b) => a.lineNo - b.lineNo)
  const ranges: Range[] = []
  for (const m of sorted) {
    const last = ranges[ranges.length - 1]
    if (last !== undefined && m.lineNo - last.end <= MERGE_GAP + 1) {
      last.end = Math.max(last.end, m.lineNo)
      last.count++
    } else {
      ranges.push({ start: m.lineNo, end: m.lineNo, count: 1 })
    }
  }
  return ranges
}

export const grepStrategy: Strategy = ({ text }) => {
  const lines = splitLines(text)
  const notes: string[] = []

  // First pass: collect matches per file, in first-appearance order.
  const groups = new Map<string, Match[]>()
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue
    const parsed = parseGrepLine(line)
    if (parsed === null) continue
    const list = groups.get(parsed.path) ?? []
    list.push({ lineNo: parsed.lineNo, raw: line, sourceLine: index + 1 })
    groups.set(parsed.path, list)
  }

  const nonEmpty = lines.filter((line) => line.trim() !== "")
  const recognized = nonEmpty.filter(
    (line) => parseGrepLine(line) !== null || groups.has(line)
  ).length
  if (nonEmpty.length === 0 || recognized / nonEmpty.length < 0.9)
    return fallbackStrategy({ text, toolId: "grep" })

  // Second pass: emit group blocks in appearance order; unparsed lines are
  // kept elidable so budget trimming can still summarize them.
  const out: CLine[] = []
  let totalMatches = 0
  let totalRanges = 0
  let keptAnchorLines = 0

  for (const [index, line] of lines.entries()) {
    const parsed = parseGrepLine(line)
    if (parsed !== null) continue // emitted below as part of its group block
    if (line.trim() === "") {
      out.push({
        text: "",
        sourceLine: index + 1,
        anchor: false,
        priority: PRI.low,
        group: "other",
      })
      continue
    }
    if (groups.has(line)) {
      out.push({ text: line, sourceLine: index + 1, anchor: true, priority: PRI.critical }) // bare path heading
      continue
    }
    out.push({
      text: line,
      sourceLine: index + 1,
      anchor: true,
      priority: PRI.normal,
      group: "other",
    })
  }

  for (const [path, matches] of groups) {
    totalMatches += matches.length
    const ranges = mergeRanges(matches)
    totalRanges += ranges.length

    // Anchors: first match (lowest line no) + error-keyword lines, file order.
    const sorted = [...matches].sort((a, b) => a.lineNo - b.lineNo)
    const first = sorted[0]
    if (first !== undefined) {
      out.push({
        text: first.raw,
        sourceLine: first.sourceLine,
        anchor: true,
        priority: PRI.critical,
        group: path,
      })
      keptAnchorLines++
    }
    for (const m of sorted) {
      if (m === first) continue
      if (ERROR_KEYWORD_RE.test(m.raw)) {
        out.push({
          text: m.raw,
          sourceLine: m.sourceLine,
          anchor: true,
          priority: PRI.critical,
          group: path,
        })
        keptAnchorLines++
      }
    }

    // Elidable range summaries.
    for (const r of ranges) {
      const label =
        r.start === r.end
          ? `${path}:${r.start} (${r.count} match${r.count === 1 ? "" : "es"})`
          : `${path}:${r.start}-${r.end} (${r.count} matches)`
      out.push({ text: label, anchor: false, priority: PRI.normal, group: path })
    }
  }

  notes.push(
    `grep: ${groups.size} file(s), ${totalMatches} match(es) -> ${totalRanges} range(s); kept ${keptAnchorLines} anchor line(s)`
  )
  return { lines: out, strategy: "grep", notes }
}
