/** Every changed line and hunk/file header is a hard anchor. */
import { PRI } from "../anchor"
import { splitLines, type Strategy } from "./types"
import { fallbackStrategy } from "./fallback"
export const diffStrategy: Strategy = ({ text, toolId }) => {
  const lines = splitLines(text)
  if (lines.some((line) => /^@@@/.test(line))) return fallbackStrategy({ text, toolId })
  if (
    !lines.some((line) => /^@@/.test(line)) ||
    lines.some(
      (line) =>
        line !== "" &&
        !/^(?:diff --git |index |--- |\+\+\+ |@@|[ +\\-]|new file mode |deleted file mode |similarity index |rename (?:from|to) )/.test(
          line
        )
    )
  )
    return fallbackStrategy({ text, toolId })
  return {
    strategy: "diff",
    lines: lines.map((line, index) => ({
      text: line,
      sourceLine: index + 1,
      anchor: !line.startsWith(" "),
      priority: PRI.normal,
      group: "diff-context",
    })),
    notes: ["diff: all changes and hunk headers protected; only context may be omitted"],
  }
}
