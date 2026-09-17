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

test("a type discriminator in arbitrary arguments or metadata does not bypass sanitization", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
  for (const available of [true, false]) {
    const security = guard(available)
    const messages = [{ info: { id: "m", role: "assistant", sessionID: "s" }, parts: [{ type: "tool", tool: "mcp_unknown", state: {
      status: "completed", input: { type: "file", description: secret }, output: "safe", metadata: { type: "image", text: secret },
    } }] }]
    expect(JSON.stringify(await security.messages("s", messages))).not.toContain(secret)
    expect(JSON.stringify(await security.object("s", { metadata: { type: "file", token: secret } }))).not.toContain(secret)
  }
})

test("generated security metadata is filtered even with credential-bearing policy labels", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
  const security = createSecurityGuard({ projectId: "p", directory: "/project",
    options: parseOptions({ security: { mode: "audit", policy: { version: secret } } }),
    port: () => ({ evaluateTool, sanitize: async p => sanitizeFields(p), async shutdown() {} }) })
  const event = { tool: "read", sessionID: "s", callID: "c" }
  await security.before(event, { args: { filePath: "/project/a.txt" } })
  const output = { output: "safe", metadata: {} }
  await security.after(event, output)
  expect(JSON.stringify(output)).not.toContain(secret)
})

test("denied calls return bounded sanitized remediation without exposing source", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
  await expect(guard().before({ tool: "write", sessionID: "s", callID: "blocked" },
    { args: { filePath: "/project/a.ts", content: `const key='${secret}'` } })).rejects.toThrow("Use a secret store or environment reference")
  try { await guard().before({ tool: "write", sessionID: "s", callID: "blocked" }, { args: { filePath: "/project/a.ts", content: secret } }) }
  catch (error) {
    const message = (error as Error).message
    expect(message).not.toContain(secret)
    expect(Math.ceil(message.length / 4)).toBeLessThanOrEqual(256)
  }
})
