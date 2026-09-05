/** Recognize host and legacy numbered read envelopes without deleting code. */
import { PRI } from "../anchor"
import { splitLines, type Strategy } from "./types"
import { fallbackStrategy } from "./fallback"
export const readStrategy: Strategy = ({ text, toolId }) => {
  const lines = splitLines(text)
  const relevant = lines.filter(
    (line) => line.trim() !== "" && !/^<\/?(?:path|type|content)(?:>|\s)/.test(line)
  )
  const numbered = relevant.filter((line) => /^\s*\d+(?::(?: |$)|[\t ])/.test(line)).length
  if (relevant.length === 0 || numbered / relevant.length < 0.9) {
    const fb = fallbackStrategy({ text, toolId })
    return {
      ...fb,
      notes: ["read: input lacks line-number format; fell back to unknown strategy", ...fb.notes],
    }
  }
  return {
    strategy: "read",
    lines: lines.map((line, index) => ({
      text: line,
      sourceLine: index + 1,
      anchor: true,
      priority: PRI.critical,
      group: "read",
    })),
    notes: [`read: preserved all ${numbered} numbered code lines`],
  }
}
