import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseOptions } from "../src/config"
import { createPluginRuntime } from "../src/runtime"

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })

async function setup(mode = "enforce", overrides: any = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vsec-plugin-"))
  const evaluated: any[] = []
  const scanner = {
    async evaluateTool(params: any) {
      evaluated.push(params)
      return { decision: params.tool === "write" ? "deny" : "allow", coverage: "complete",
        findings: params.tool === "write" ? [{ ruleId: "credential", category: "credential",
          severity: "critical", confidence: "high", message: "Credential detected", remediation: "Use environment variables" }] : [],
        policyVersion: "vsec-1", diagnostics: [] }
    },
    async sanitize(params: any) { return { fields: params.fields.map((s: string) => s.replaceAll(SECRET, "[REDACTED]")),
      redactions: 1, coverage: "complete", policyVersion: "vsec-1" } },
    async shutdown() {},
  }
  const runtime = createPluginRuntime({ projectId: "project", directory,
    options: parseOptions({ mode: "off", security: { mode } }), rtk: null, headroom: null,
    security: scanner, ...overrides } as any)
  cleanups.push(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { runtime: runtime as any, directory, scanner, evaluated }
}

test("security enforce survives disabling both compression components and blocks before side effects", async () => {
  const { runtime } = await setup()
  let executed = false
  await expect((async () => {
    await runtime.toolBefore({ tool: "write", sessionID: "s", callID: "c" },
      { args: { filePath: "new.ts", content: `const key = '${SECRET}'` } })
    executed = true
  })()).rejects.toThrow("VSecAgent")
  expect(executed).toBe(false)
})

test("audit permits flagged writes but still sanitizes short output and nested metadata", async () => {
  const { runtime } = await setup("audit")
  await runtime.toolBefore({ tool: "write", sessionID: "s", callID: "c" },
    { args: { filePath: "new.ts", content: SECRET } })
  const output = { output: SECRET, metadata: { detail: { token: SECRET } } }
  await runtime.toolAfter({ tool: "write", sessionID: "s", callID: "c", args: {} }, output)
  expect(JSON.stringify(output)).not.toContain(SECRET)
  expect(output.output).toContain("REDACTED")
})

test("unavailable scanner blocks writes while reads run with withheld evidence", async () => {
  const { runtime } = await setup("enforce", { security: null })
  await expect(runtime.toolBefore({ tool: "write", sessionID: "s", callID: "c" },
    { args: { filePath: "new.ts", content: "safe" } })).rejects.toThrow("VSecAgent")
  await runtime.toolBefore({ tool: "read", sessionID: "s", callID: "c" }, { args: { filePath: "normal.ts" } })
  const output = { output: SECRET, metadata: { output: SECRET } }
  await runtime.toolAfter({ tool: "read", sessionID: "s", callID: "c", args: {} }, output)
  expect(JSON.stringify(output)).not.toContain(SECRET)
  expect(output.output).toContain("unavailable")
})

test("messages and system prompts are filtered even with headroom disabled", async () => {
  const { runtime } = await setup()
  const output = { messages: [{ info: { id: "u", role: "user", sessionID: "s" },
    parts: [{ type: "text", text: `Keep API compatibility. ${SECRET}` }] }] }
  await runtime.transform(output)
  expect(output.messages[0]!.parts[0]!.text).toBe("Keep API compatibility. [REDACTED]")
  const system = { system: [`System ${SECRET}`] }
  await runtime.systemTransform("s", system)
  expect(system.system).toEqual(["System [REDACTED]"])
})

test("retrieved evidence is sanitized despite RTK bypass and cursors remain intact", async () => {
  const { runtime } = await setup()
  const value = { content: SECRET, nextCursor: "opaque-source-offset", found: true }
  const filtered = await runtime.sanitizeRetrieval("s", value)
  expect(filtered).toEqual({ content: "[REDACTED]", nextCursor: "opaque-source-offset", found: true })
  const output = { output: SECRET, metadata: { bluecode: { retrieved: true } } }
  await runtime.toolAfter({ tool: "headroom_retrieve", sessionID: "s", callID: "c", args: {} }, output)
  expect(output.output).toBe("[REDACTED]")
})

test("exact edit previews include prior content without changing submitted arguments", async () => {
  const { runtime, directory, evaluated } = await setup()
  await writeFile(join(directory, "file.ts"), "const a = 1;\nconst b = 2;\n")
  const args = { filePath: "file.ts", oldString: "a = 1", newString: "a = 3" }
  await runtime.toolBefore({ tool: "edit", sessionID: "s", callID: "c" }, { args })
  expect(evaluated[0].files[0]).toMatchObject({ complete: true,
    before: "const a = 1;\nconst b = 2;\n", content: "const a = 3;\nconst b = 2;\n" })
  expect(args).toEqual({ filePath: "file.ts", oldString: "a = 1", newString: "a = 3" })
})

test("failed message sanitization withholds text while preserving host routing and tool state", async () => {
  const { runtime } = await setup("enforce", { security: null })
  const output = { messages: [{ info: { id: "msg_a", role: "assistant", sessionID: "s" },
    parts: [{ id: "part_a", messageID: "msg_a", sessionID: "s", type: "tool", tool: "read", callID: "c",
      state: { status: "completed", input: { filePath: SECRET }, output: SECRET } }] }] }
  await runtime.transform(output)
  expect(JSON.stringify(output)).not.toContain(SECRET)
  expect(output.messages[0]!.info).toEqual({ id: "msg_a", role: "assistant", sessionID: "s" })
  expect(output.messages[0]!.parts[0]).toMatchObject({ id: "part_a", type: "tool", tool: "read", callID: "c", state: { status: "completed" } })
})

test("upstream compaction context is sanitized without headroom", async () => {
  const { runtime } = await setup()
  const output = { context: [SECRET] }
  await runtime.compacting("s", output)
  expect(output.context).toEqual(["[REDACTED]"])
})

test("security-off defaults retain the original archive namespace and evidence", async () => {
  const { runtime } = await setup("off")
  const output = { output: SECRET }
  await runtime.toolAfter({ tool: "read", sessionID: "s", callID: "c", args: {} }, output)
  expect(output.output).toBe(SECRET)
  expect(runtime.securityStats().scans).toBe(0)
})

test("oversized evidence is withheld whole and bypasses RTK instead of reporting compression savings", async () => {
  let calls = 0
  const { runtime } = await setup("enforce", {
    options: parseOptions({ mode: "on", security: { mode: "enforce" } }),
    rtk: { async compress() { calls++; return { kind: "unchanged", output: "" } }, async shutdown() {} },
  })
  const output: any = { output: "x".repeat(1024 ** 2 + 1) }
  await runtime.toolAfter({ tool: "read", sessionID: "s", callID: "c", args: {} }, output)
  expect(output.output).toContain("withheld")
  expect(output.metadata.vsec.withheld).toBe(true)
  expect(calls).toBe(0)
})
