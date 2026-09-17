import { expect, test } from "bun:test"
import { evaluateTool, sanitizeFields } from "../../security-core/src/index"
import { parseOptions } from "../src/config"
import { createSecurityGuard, WITHHELD } from "../src/security"

function guard(available = true) {
  return createSecurityGuard({ projectId: "p", directory: "/project", options: parseOptions({ security: { mode: "enforce" } }),
    port: () => available ? { evaluateTool, sanitize: async p => sanitizeFields(p), async shutdown() {} } : null })
}
test("structured credential assignments in tool arguments and metadata are sanitized", async () => {
  const value = { metadata: { credentials: { password: "Correct.Horse.Battery.912!" } },
    state: { input: { apiKey: "PlausibleLongCredential42" } }, safe: "Keep exported APIs unchanged." }
  const clean = await guard().object("s", value)
  expect(JSON.stringify(clean)).not.toContain("Correct.Horse")
  expect(JSON.stringify(clean)).not.toContain("PlausibleLong")
  expect(clean.safe).toBe(value.safe)
})
test("text line breaks survive structured filtering and repeated passes", async () => {
  const value = { output: 'password="CorrectHorseBattery912!"\nKeep API\nKeep UI' }
  const security = guard(), clean = await security.object("s", value)
  expect(clean.output).toBe('password="[REDACTED]"\nKeep API\nKeep UI')
  expect(await security.object("s", clean)).toEqual(clean)
})
test("arbitrary metadata keys cannot carry credentials into archives", async () => {
  const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
  const clean = await guard().object("s", { metadata: { [key]: "value" } })
  expect(JSON.stringify(clean)).not.toContain(key)
  expect(JSON.stringify(await guard(false).object("s", { metadata: { [key]: "value" } }))).not.toContain(key)
})
