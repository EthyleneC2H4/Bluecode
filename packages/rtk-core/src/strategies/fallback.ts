/** Unknown syntax is never evidence that content is safe to discard. */
import { PRI } from "../anchor"
import { splitLines, type Strategy } from "./types"
export const fallbackStrategy: Strategy = ({ text }) => ({
  strategy: "unknown",
  lines: splitLines(text).map((line, index) => ({
    text: line,
    sourceLine: index + 1,
    anchor: true,
    priority: PRI.critical,
    group: "output",
  })),
  notes: ["unknown: conservative direct passthrough"],
})
