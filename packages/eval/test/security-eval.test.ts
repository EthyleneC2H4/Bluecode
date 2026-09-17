import { expect, test } from "bun:test"
import type { SecurityDecision } from "@bluecode/contracts"
import { acceptanceFixtures, developmentFixtures, type SecurityFixture } from "../src/security-fixtures"
import { summarizeSecurity, runSecurityFixtures, accountSecurityText, latencySummary, type SecurityObservation } from "../src/security-eval"

function fixture(id: string, overrides: Partial<SecurityFixture> = {}): SecurityFixture {
  return { ...acceptanceFixtures[0]!, id, ...overrides }
}
function result(f: SecurityFixture, decision: SecurityDecision["decision"], category = f.category, coverage: SecurityDecision["coverage"] = "complete"): SecurityObservation {
  return { fixture: f, elapsedMs: 1, result: { decision, coverage, policyVersion: "vsec-1", diagnostics: [], findings: decision === "allow" || decision === "unavailable" ? [] : [{ ruleId: "test-rule", category, severity: "high", confidence: "high", message: "test", remediation: "test" }] } }
}

test("accounting does not turn warnings into critical blocks or unrelated findings into recall", () => {
  const observations = [
    result(fixture("critical-warning"), "warn"),
    result(fixture("critical-block"), "deny"),
    result(fixture("wrong-category", { expectedHighConfidenceCritical: false }), "warn", "xss"),
    result(fixture("partial-miss", { expectedHighConfidenceCritical: false }), "allow", "credential", "partial"),
    result(fixture("benign-warning", { label: "benign", expectedHighConfidenceCritical: false }), "warn"),
    result(fixture("benign-block", { label: "benign", expectedHighConfidenceCritical: false }), "deny"),
  ]
  const summary = summarizeSecurity(observations)
  expect(summary.total).toMatchObject({ total: 6, risk: 4, benign: 2, supportedRisk: 4, supportedRiskDetected: 2, criticalExpected: 2, criticalBlocked: 1, warned: 3, denied: 2, uncovered: 1, falseBlocks: 1, falseWarnings: 1 })
  expect(summary.rates).toMatchObject({ supportedRiskRecall: 0.5, criticalBlocking: 0.5, benignFalseBlockRate: 0.5, benignFalseWarningRate: 0.5 })
  expect(summary.passed).toBe(false)
})

test("coverage errors cannot remove supported risks from the denominator", () => {
  const failed: SecurityObservation = { fixture: fixture("timeout"), elapsedMs: 1001, error: "timeout" }
  const unsupported = result(fixture("declared-unsupported", { supportedScope: "unsupported", expectedHighConfidenceCritical: false }), "allow", "credential", "unsupported")
  const summary = summarizeSecurity([failed, unsupported])
  expect(summary.total).toMatchObject({ total: 2, supportedRisk: 1, supportedRiskDetected: 0, unavailable: 1, uncovered: 2 })
  expect(summary.rates.supportedRiskRecall).toBe(0)
  expect(summary.gates.transportComplete).toBe(false)
})

test("quality gates use inclusive thresholds, reject empty samples, and count false warnings independently", () => {
  const good = Array.from({ length: 19 }, (_, i) => result(fixture(`risk-${i}`, { expectedHighConfidenceCritical: i === 0 }), i === 0 ? "deny" : "warn"))
  const miss = result(fixture("miss", { expectedHighConfidenceCritical: false }), "allow")
  const safe = Array.from({ length: 20 }, (_, i) => result(fixture(`safe-${i}`, { label: "benign", expectedHighConfidenceCritical: false }), i === 0 ? "warn" : "allow"))
  expect(summarizeSecurity([...good, miss, ...safe]).passed).toBe(true)
  expect(summarizeSecurity([...good.slice(1), miss, ...safe]).passed).toBe(false)
  expect(summarizeSecurity([...good, miss, ...safe, result(fixture("extra-warning", { label: "benign", expectedHighConfidenceCritical: false }), "warn")]).gates.benignFalseWarnings).toBe(false)
  expect(summarizeSecurity([]).passed).toBe(false)
})

test("scanner failures are retained as observations while later fixtures still run", async () => {
  let calls = 0
  const observed = await runSecurityFixtures([fixture("fails"), fixture("succeeds")], async () => {
    if (++calls === 1) throw Object.assign(new Error("DO NOT serialize scanner payload"), { reason: "timeout" })
    return { decision: "allow", coverage: "complete", findings: [], diagnostics: [], policyVersion: "vsec-1" }
  })
  expect(observed).toHaveLength(2)
  expect(observed[0]!.error).toBe("timeout")
  expect(observed[1]!.result?.decision).toBe("allow")
  expect(JSON.stringify(observed)).not.toContain("DO NOT serialize")
})

test("text accounting preserves factual constraints and never books redaction or withholding as compression", () => {
  const summary = accountSecurityText([
    { before: "Keep retries=4. credential material", after: "Keep retries=4. [REDACTED]", constraints: ["retries=4"], secret: "credential material", redactions: 1, withheld: false, beforeTokens: 10, afterTokens: 8 },
    { before: "TLS=required credential material", after: "[VSecAgent: security inspection unavailable; content withheld]", constraints: ["TLS=required"], secret: "credential material", redactions: 0, withheld: true, beforeTokens: 7, afterTokens: 12 },
  ])
  expect(summary).toMatchObject({ total: 2, constraintsTotal: 2, constraintsRetained: 1, secretLeaks: 0, redactions: 1, withheldFields: 1, rawTokens: 17, modelVisibleTokens: 20, securityTokenDelta: 3, compressionSavingsTokens: 0, withheldInputTokens: 7 })
})

test("nearest-rank latency uses p95 tail and preserves missing samples", () => {
  expect(latencySummary([])).toEqual({ count: 0, p50Ms: null, p95Ms: null, maxMs: null })
  expect(latencySummary(Array.from({ length: 20 }, (_, i) => i + 1))).toEqual({ count: 20, p50Ms: 10, p95Ms: 19, maxMs: 20 })
})

test("frozen datasets are balanced and all critical labels precede execution", () => {
  expect(acceptanceFixtures).toHaveLength(320)
  expect(developmentFixtures).toHaveLength(160)
  for (const group of [acceptanceFixtures, developmentFixtures]) {
    const categories = new Set(group.map(f => f.category))
    expect(categories.size).toBe(8)
    for (const category of categories) for (const label of ["risk", "benign"]) expect(group.filter(f => f.category === category && f.label === label)).toHaveLength(group.length / 16)
    expect(group.filter(f => f.label === "benign").some(f => f.expectedHighConfidenceCritical)).toBe(false)
  }
})

test("CLI import is inert, performance is opt-in, and incomplete options fail before work", async () => {
  const { parseSecurityOptions } = await import("../src/security-cli")
  expect(parseSecurityOptions([])).toMatchObject({ performance: false, samples: 32, phase: "reproduction" })
  expect(parseSecurityOptions(["--performance", "--samples", "20", "--phase", "retest"])).toMatchObject({ performance: true, samples: 20, phase: "retest" })
  for (const args of [["--output"], ["--unknown"], ["--phase", "pass"], ["--samples", "19"], ["--samples", "NaN"]]) expect(() => parseSecurityOptions(args)).toThrow()
})
