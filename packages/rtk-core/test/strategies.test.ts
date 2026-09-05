import { describe, expect, test } from "bun:test"
import { estimateTokens } from "@bluecode/shared"
import { applyBudget } from "../src/budget"
import { diffStrategy } from "../src/strategies/diff"
import { fallbackStrategy } from "../src/strategies/fallback"
import { grepStrategy } from "../src/strategies/grep"
import { lsStrategy } from "../src/strategies/ls"
import { readStrategy } from "../src/strategies/read"
import type { CLine, Strategy } from "../src/strategies/types"
import { testStrategy } from "../src/strategies/test"
import {
  DIFF_OUT,
  GO_TEST_OUT,
  GREP_OUT,
  JEST_OUT,
  LS_LA,
  NOISE,
  PATH_LIST,
  READ_OUT,
} from "./fixtures"

/** Footer cost upper bound (5-digit elided counter) used to size budgets. */
const FOOTER_MAX = estimateTokens(
  '[bluecode rtk] compressed: rawHash=sha256:0000000000000000000000000000000000000000000000000000000000000000 (99999 tokens elided). Full output: headroom_retrieve(hash="sha256:0000000000000000000000000000000000000000000000000000000000000000")'
)

interface Row {
  name: string
  strategy: Strategy
  text: string
}

function anchorCostOf(lines: CLine[]): number {
  return lines.filter((l) => l.anchor).reduce((sum, l) => sum + estimateTokens(l.text) + 1, 0)
}

/**
 * A budget that provably fits anchors + per-group summaries + footer while
 * staying below rawTokens, so `compressed:true` and
 * `estimate(output) <= budget` hold by construction.
 */
function tightBudget(text: string, lines: CLine[], tool: string): number {
  const rawEst = estimateTokens(text)
  // Worst case: every distinct elidable group emits its own summary line.
  const groups = new Set(lines.filter((l) => !l.anchor).map((l) => l.group ?? tool))
  const summaryAllowance = groups.size * 14
  const floor = anchorCostOf(lines) + FOOTER_MAX + summaryAllowance + 8
  const budget = Math.max(floor, Math.floor(rawEst / 2))
  expect(budget).toBeLessThan(rawEst) // fixture sanity: compression achievable
  return budget
}

describe("strategy table: tightened-budget properties", () => {
  const FALLBACK_BULK = Array.from(
    { length: 40 },
    (_, i) => `unique fallback line ${i} carrying padding words`
  ).join("\n")

  const rows: Row[] = [
    { name: "ls -la folding", strategy: lsStrategy, text: LS_LA },
    { name: "path-list folding", strategy: lsStrategy, text: PATH_LIST },
    { name: "grep grouping", strategy: grepStrategy, text: GREP_OUT },
    { name: "jest failures", strategy: testStrategy, text: JEST_OUT },
  ]

  for (const row of rows) {
    test(`${row.name}: anchors survive, output fits budget incl. hint`, () => {
      const sr = row.strategy({ text: row.text, toolId: "bash" })
      expect(sr.lines.length).toBeGreaterThan(0)
      expect(sr.notes.length).toBeGreaterThan(0)

      const budget = tightBudget(row.text, sr.lines, "bash")
      const out = applyBudget(sr.lines, {
        budgetTokens: budget,
        rawHash: "sha256:" + "a".repeat(64),
        rawTokensEst: estimateTokens(row.text),
        tool: "bash",
      })

      // Property 1: estimate within budget, retrieval hint included.
      expect(estimateTokens(out.text)).toBeLessThanOrEqual(budget)
      expect(out.text).toContain("[bluecode rtk] compressed: rawHash=sha256:")
      expect(out.text).toContain('headroom_retrieve(hash="sha256:' + "a".repeat(64) + '")')

      // Property 2: every anchor line appears verbatim in the final text.
      for (const line of sr.lines) {
        if (line.anchor) expect(out.text).toContain(line.text)
      }

      // Property 3: whenever something was trimmed, a group summary exists.
      if (out.elidedTokens > 0) expect(out.text).toContain("[+")
    })
  }
})

describe("ls strategy structure", () => {
  test("ls -la: total + dirs anchored, files folded to one summary", () => {
    const sr = lsStrategy({ text: LS_LA, toolId: "ls" })
    expect(sr.strategy).toBe("ls")
    expect(sr.lines.some((l) => l.text === "total 48" && l.anchor)).toBe(true)
    const dirAnchors = sr.lines.filter((l) => l.anchor && l.text.startsWith("drwx"))
    expect(dirAnchors.length).toBe(2) // "." and ".."
    // 9 files: keep 8, fold exactly 1 into "[+1 file in .]"
    const kept = sr.lines.filter((l) => !l.anchor && l.text.startsWith("-rw-")).length
    expect(kept).toBe(8)
    expect(sr.lines.some((l) => l.text === "[+1 file in .]")).toBe(true)
  })

  test("path list: common prefix header, per-dir keep-5, fold summaries", () => {
    const sr = lsStrategy({ text: PATH_LIST, toolId: "glob" })
    expect(sr.strategy).toBe("ls")
    expect(
      sr.lines.some((l) => l.anchor && l.text.startsWith("packages/core/ (common prefix"))
    ).toBe(true)
    // internal/ holds 7 entries: keep 5, fold 2; dist/ holds 25: fold 20.
    expect(sr.lines.some((l) => l.text === "[+2 in packages/core/src/internal/]")).toBe(true)
    expect(sr.lines.some((l) => l.text === "[+20 in packages/core/dist/]")).toBe(true)
    const internalKept = sr.lines.filter(
      (l) => l.anchor && l.group === "packages/core/src/internal"
    )
    expect(internalKept.length).toBe(5)
  })
})

describe("grep strategy structure", () => {
  test("ranges merge near-contiguous matches; error lines anchor", () => {
    const sr = grepStrategy({ text: GREP_OUT, toolId: "grep" })
    expect(sr.strategy).toBe("grep")
    const texts = sr.lines.map((l) => l.text)
    expect(texts).toContain("src/app.ts:1-5 (5 matches)")
    expect(texts).toContain("src/app.ts:15 (1 match)")
    expect(texts).toContain("src/app.ts:300-329 (30 matches)")
    expect(texts).toContain("src/app.ts:400 (1 match)")
    expect(texts).toContain("src/util.ts:40-42 (3 matches)")
    expect(texts).toContain("src/util.ts:90 (1 match)")
    // Anchors: heading path, first match, ERROR line, warn lines.
    const anchors = sr.lines.filter((l) => l.anchor).map((l) => l.text)
    expect(anchors).toContain("src/app.ts") // bare path heading
    expect(anchors).toContain('src/app.ts:1:import { serve } from "./server"')
    expect(anchors.some((t) => t.includes("ERROR unhandled rejection"))).toBe(true)
    expect(anchors.some((t) => t.includes("warn: deprecated API use detected"))).toBe(true)
    // Non-keyword content is never anchored.
    expect(anchors.some((t) => t.includes("consider migrating soon"))).toBe(false)
    expect(anchors.some((t) => t.includes("filler match"))).toBe(false)
  })
})

describe("read strategy structure", () => {
  test("all read code lines anchored", () => {
    const sr = readStrategy({ text: READ_OUT, toolId: "read" })
    expect(sr.strategy).toBe("read")
    const anchors = sr.lines.filter((l) => l.anchor)
    expect(anchors.length).toBe(200) // 20 head + 20 tail of 200 numbered lines
    expect(anchors.some((a) => a.text.includes("ANCHOR_UNIQUE_TOP_CONTENT"))).toBe(true)
    expect(anchors.some((a) => a.text.includes("ANCHOR_UNIQUE_BOTTOM_CONTENT"))).toBe(true)
    expect(sr.lines.map((line) => line.text).join("\n")).toBe(READ_OUT.trimEnd())
  })

  test("without line numbers falls back to unknown strategy", () => {
    const sr = readStrategy({ text: NOISE, toolId: "read" })
    expect(sr.strategy).toBe("unknown")
    expect(sr.notes.some((n) => n.includes("fell back to unknown"))).toBe(true)
  })
})

describe("diff strategy structure", () => {
  test("every changed line and hunk header is anchored", () => {
    const sr = diffStrategy({ text: DIFF_OUT, toolId: "bash" })
    for (const line of DIFF_OUT.split("\n")) {
      if (/^(?:[+-]|@@|diff --git)/.test(line))
        expect(sr.lines.some((item) => item.text === line && item.anchor)).toBe(true)
    }
  })

  test("hunk-body lines starting ---/+++ count as changes, not file headers (devlog #39)", () => {
    // Deleting a "- bullet" line yields a "--- ..." diff line INSIDE the hunk;
    // adding a "+ bullet" yields "++ ...". Both must land in the +/- stats —
    // the unconditional /^--- / skip used to drop the deletion side.
    const text = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,3 +1,3 @@",
      " context",
      "--- - bullet removed",
      "++ + bullet added",
      " trailing context",
    ].join("\n")
    const sr = diffStrategy({ text, toolId: "bash" })
    const texts = sr.lines.map((l) => l.text)
    expect(sr.lines.filter((line) => line.anchor).map((line) => line.text)).toContain(
      "--- - bullet removed"
    )
    // Emission already classified both as hunk-body changes; stats now agree.
    expect(texts).toContain("--- - bullet removed")
    expect(texts).toContain("++ + bullet added")
  })
})

describe("test strategy structure", () => {
  test("jest: failure block anchored, passes folded, summaries anchored", () => {
    const sr = testStrategy({ text: JEST_OUT, toolId: "bash" })
    expect(sr.strategy).toBe("test")
    const anchors = sr.lines.filter((l) => l.anchor).map((l) => l.text)
    expect(anchors.some((t) => t.includes("✗ throws on bad input"))).toBe(true)
    expect(anchors.some((t) => t.includes('Expected: "boom"'))).toBe(true)
    expect(anchors.some((t) => t.includes('Received: "quiet failure"'))).toBe(true)
    expect(anchors.some((t) => t.includes("Test Suites: 1 failed"))).toBe(true)
    expect(anchors.some((t) => t.startsWith("PASS src/app.test.ts"))).toBe(true)
    const fold = sr.lines.find((l) => /^✓ \d+ passed \(elided\)$/.test(l.text))
    expect(fold?.text).toBe("✓ 30 passed (elided)")
    expect(fold?.group).toBe("src/app.test.ts")
    // No generated passing case survives verbatim.
    expect(sr.lines.some((l) => l.text.includes("handles generated case"))).toBe(false)
  })

  test("go test: --- FAIL block kept verbatim", () => {
    const sr = testStrategy({ text: GO_TEST_OUT, toolId: "bash" })
    const anchors = sr.lines.filter((l) => l.anchor).map((l) => l.text)
    expect(anchors.some((t) => t.startsWith("--- FAIL: TestSub"))).toBe(true)
    expect(anchors.some((t) => t.includes("got -1, want -2"))).toBe(true)
    expect(anchors.some((t) => t === "FAIL")).toBe(true)
    // Passing cases do not get anchors.
    expect(anchors.filter((t) => t.startsWith("--- PASS")).length).toBe(0)
  })
})

describe("fallback strategy structure", () => {
  test("unknown content and blank duplicates stay byte-identical", () => {
    const text = "alpha\nalpha\nalpha\n\n\n\nbeta\n\nbeta"
    const sr = fallbackStrategy({ text, toolId: "bash" })
    expect(sr.strategy).toBe("unknown")
    expect(sr.lines.map((line) => line.text).join("\n")).toBe(text)
    expect(sr.lines.every((line) => line.anchor)).toBe(true)
  })
})
