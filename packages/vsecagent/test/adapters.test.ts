import { expect, test } from "bun:test"
import * as adapters from "../src/adapters"
const namespace = { projectId: "project", sessionId: "session" }
const policy = { version: "vsec-1", exceptions: [], deniedPaths: [], mcpTools: {} }
const token = "ghp_Ab9cD8eF7gH6iJ5kL4mN3oP2qR1sT0uV9wX8"
const params = { namespace, policy, fields: [token] }
const evaluate = { namespace, policy, tool: "read", args: {}, root: "/project", cwd: "/project", paths: [], files: [] }
test("redactor API is independently injectable and local redaction verifies SDK output", async () => {
  expect(adapters.callRedactor).toBeFunction()
  const result = await adapters.callRedactor({ version: "mock-1", sanitize: async () => ({ fields: [token], redactions: 0, coverage: "complete", policyVersion: "vsec-1" }) }, params, 100)
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result)).not.toContain(token)
  if (result.ok) expect(result.value.fields).toEqual(["[REDACTED]"])
})
test.each(["timeout", "malformed", "exception", "partial"])("redactor %s cannot return unsafe evidence", async mode => {
  expect(adapters.callRedactor).toBeFunction()
  let aborted = false
  const adapter = { version: "mock-1", sanitize: async (_input: unknown, context: { signal: AbortSignal }) => {
    context.signal.addEventListener("abort", () => { aborted = true })
    if (mode === "timeout") return new Promise(() => {})
    if (mode === "exception") throw new Error(token)
    if (mode === "partial") return { fields: [token], redactions: 0, coverage: "partial", policyVersion: "vsec-1" }
    return { fields: [token], detail: token }
  } }
  const result = await adapters.callRedactor(adapter, params, 10)
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain(token)
  if (mode === "timeout") expect(aborted).toBe(true)
})
test("firewall API maps decisions without returning SDK evidence or arbitrary identifiers", async () => {
  expect(adapters.callFirewall).toBeFunction()
  const result = await adapters.callFirewall({ version: "mock-1", evaluate: async () => ({ decision: "deny", coverage: "complete", policyVersion: token, diagnostics: [token], findings: [{ ruleId: token, category: "credential", severity: "critical", confidence: "high", message: token, remediation: token, location: { path: token, line: 1 } }] }) }, evaluate, 100)
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result)).not.toContain(token)
  if (result.ok) expect(result.value.decision).toBe("deny")
})
test.each(["timeout", "malformed", "exception"])("firewall %s yields a safe typed failure", async mode => {
  expect(adapters.callFirewall).toBeFunction()
  const result = await adapters.callFirewall({ version: "mock-1", evaluate: async () => {
    if (mode === "timeout") return new Promise(() => {})
    if (mode === "exception") throw new Error(token)
    return { decision: "allow", detail: token }
  } }, evaluate, 10)
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain(token)
})
