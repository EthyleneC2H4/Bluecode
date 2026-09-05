import { expect, test } from "bun:test"
import { compressToolOutput } from "../src/pipeline"
import { diffStrategy } from "../src/strategies/diff"
import { testStrategy } from "../src/strategies/test"
import { applyBudget } from "../src/budget"

test("host colon read preserves every code line and reports soft budget excess", async () => {
  const text = [
    "<path>/tmp/a.ts</path>",
    "<type>file</type>",
    "<content>",
    ...Array.from({ length: 100 }, (_, i) => `${i + 1}: const value${i} = ${i};`),
    "</content>",
  ].join("\n")
  const result = await compressToolOutput({ tool: "read", output: text, budgetTokens: 20 })
  expect(result.strategy).toBe("read")
  expect(result.output).toBe(text)
  expect(result.status).toBe("unchanged")
  expect(result.budgetExceeded).toBe(true)
})

test("unknown and low coverage forced parsers pass through with actual unknown strategy", async () => {
  const text = Array.from(
    { length: 100 },
    (_, i) => `unstructured diagnostic ${i} must survive`
  ).join("\n")
  for (const tool of ["mystery", "read", "grep", "ls"]) {
    const result = await compressToolOutput({ tool, output: text, budgetTokens: 20 })
    expect(result.output).toBe(text)
    expect(result.strategy).toBe("unknown")
    expect(result.degraded).toBeNull()
  }
})

for (let count = 0; count <= 7; count++)
  test(`diff preserves all ${count} changed lines under tiny budget`, async () => {
    const changes = Array.from({ length: count }, (_, i) => `${i % 2 ? "-" : "+"}changed ${i}`)
    const text = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,7 +1,7 @@", ...changes].join(
      "\n"
    )
    const result = diffStrategy({ text, toolId: "bash" })
    for (const line of changes)
      expect(result.lines.some((item) => item.text === line && item.anchor)).toBe(true)
    const compressed = await compressToolOutput({
      tool: "bash",
      output: text,
      budgetTokens: 1,
      classifyOverride: "diff",
    })
    for (const line of changes) expect(compressed.output).toContain(line)
  })

test("failure seed runs preserve complete diagnostics in linear time", () => {
  const text = Array.from({ length: 15000 }, (_, i) => `  TypeError: unique failure ${i}`).join(
    "\n"
  )
  const start = performance.now()
  const result = testStrategy({ text, toolId: "bash" })
  expect(performance.now() - start).toBeLessThan(1500)
  expect(result.lines.filter((line) => line.anchor)).toHaveLength(15000)
})

test("budget never expands tiny alternating groups and processes large input promptly", () => {
  const lines = Array.from({ length: 12000 }, (_, i) => ({
    text: "x",
    anchor: i % 2 === 0,
    priority: 10,
    group: `g${i}`,
  }))
  const start = performance.now()
  const result = applyBudget(lines, {
    budgetTokens: 1,
    rawHash: `sha256:${"a".repeat(64)}`,
    rawTokensEst: 6000,
    tool: "test",
  })
  expect(performance.now() - start).toBeLessThan(1500)
  expect(result.text.length).toBeLessThan(lines.length * 2 + 300)
})

test("compressed output describes actual budget and omitted source ranges", async () => {
  const text = Array.from(
    { length: 300 },
    (_, i) => `src/a.ts:${i + 1}:repeated match payload ${i}`
  ).join("\n")
  const result = await compressToolOutput({ tool: "grep", output: text })
  expect(result.status).toBe("compressed")
  expect(result.targetTokens).toBe(512)
  expect(result.actualTokens).toBe(result.outTokensEst)
  expect(result.omittedRanges.length).toBeGreaterThan(0)
})

test("all unindented failure details and code frames survive", async () => {
  const diagnostics = [
    "FAIL suite.test.ts",
    "plain diagnostic before expected",
    "Expected: 1",
    "Received: 2",
    "",
    "unindented diagnosis after blank",
    "  21 | return wrong",
    "     |        ^",
    "final failure explanation",
  ]
  const text = [
    ...Array.from({ length: 150 }, (_, i) => `    ✓ success ${i}`),
    ...diagnostics,
  ].join("\n")
  const result = await compressToolOutput({ tool: "test-runner", output: text, budgetTokens: 1 })
  for (const line of diagnostics) expect(result.output).toContain(line)
  expect(result.budgetExceeded).toBe(true)
})

test("omitted source ranges never mistake a synthetic summary for a retained duplicate", async () => {
  const text = [
    "✓ 30 passed (elided)",
    ...Array.from({ length: 29 }, (_, i) => `✓ generated successful case with padding ${i}`),
    "Tests: 30 passed",
  ].join("\n")
  const result = await compressToolOutput({ tool: "test-runner", output: text, budgetTokens: 200 })
  expect(result.compressed).toBe(true)
  expect(result.omittedRanges).toEqual([{ startLine: 1, endLine: 30 }])
})

test("checkmark snapshot diagnostics remain protected inside failures", async () => {
  const output = [
    ...Array.from({ length: 100 }, (_, i) => `  ✓ passing test ${i}`),
    "FAIL snapshot.test.ts",
    "Expected:",
    "    ✓ actual multiline snapshot value",
    "Received:",
    "    missing value",
  ].join("\n")
  const result = await compressToolOutput({
    tool: "bash",
    output,
    budgetTokens: 1,
    classifyOverride: "test",
  })
  expect(result.compressed).toBe(true)
  expect(result.output).toContain("    ✓ actual multiline snapshot value")
  expect(result.output).toContain("Received:")
})

test("combined hunks fall back until parent prefix columns can be parsed", async () => {
  const output = [
    "@@@ -1,20 -1,20 +1,20 @@@",
    ...Array.from({ length: 20 }, (_, i) => ` +changed ${i}`),
  ].join("\n")
  const result = await compressToolOutput({
    tool: "bash",
    output,
    budgetTokens: 1,
    classifyOverride: "diff",
  })
  expect(result.output).toBe(output)
})
