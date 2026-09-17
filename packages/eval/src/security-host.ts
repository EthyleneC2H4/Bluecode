/** Opt-in actual OpenCode integration, driven entirely by a loopback mock model. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { createCommandScope } from "./live-process"
import { securityEnvironment } from "./security-eval"
import { createHash } from "node:crypto"

const CANARY = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
interface Action { tool: string; args: Record<string, unknown> }
function stream(action?: Action) {
  const base = { id: "chatcmpl-vsec", object: "chat.completion.chunk", created: 1, model: "mock" }
  const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  return new Response(chunk({ role: "assistant", ...(action ? { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID().replaceAll("-", "")}`, type: "function", function: { name: action.tool, arguments: JSON.stringify(action.args) } }] } : { content: "VSEC_OK" }) }) + chunk({}, action ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}
async function jsonLines(file: string): Promise<any[]> { return (await readFile(file, "utf8").catch(() => "")).split("\n").flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }) }

export async function runSecurityHost(output: string) {
  const meta = { ...await securityEnvironment(["bun", "packages/eval/src/security-host.ts", output]),
    driverDigests: Object.fromEntries(await Promise.all(["security-host", "security-host-plugin", "security-host-mcp"].map(async name => [name, createHash("sha256").update(await Bun.file(new URL(`./${name}.ts`, import.meta.url)).text()).digest("hex")]))) }
  const root = await mkdtemp(join(tmpdir(), "vsec-real-host-")), commands = createCommandScope()
  const version = (await commands.command(["opencode", "--version"], root, {}, 10000)).stdout.trim()
  if (version !== "1.18.23") { await commands.close(); await rm(root, { recursive: true, force: true }); throw Error("Host acceptance requires OpenCode 1.18.23") }
  const records: any[] = []
  try {
    for (const scenario of ["standard", "patch", "code-mode", "scanner-failure"] as const) {
      const sandbox = join(root, scenario), work = join(sandbox, "work")
      await mkdir(work, { recursive: true })
      await writeFile(join(work, "observation.txt"), `Keep PUBLIC_API.\n${CANARY}\nKeep tests.`)
      const traceFile = join(sandbox, "hooks.jsonl")
      const model = scenario === "patch" ? "gpt-5-mock" : "mock"
      const calls: any[] = [], counters = new Map<string, number>()
      const actions: Action[] = scenario === "standard" ? [
        { tool: "write", args: { filePath: join(work, "blocked.ts"), content: `const key = '${CANARY}'` } },
        { tool: "write", args: { filePath: join(work, "safe.ts"), content: "export const value = 1\n" } },
        { tool: "read", args: { filePath: join(work, "observation.txt") } },
        { tool: "edit", args: { filePath: join(work, "safe.ts"), oldString: "value = 1", newString: "value = 2" } },
        { tool: "bash", args: { command: "printf '%s\\n' safe-run", description: "Print safe fixture" } },
        { tool: "probe_save", args: { path: ".env", content: "safe blocked fixture" } },
        { tool: "probe_read", args: { path: "observation.txt" } },
        { tool: "task", args: { description: "Check child hook", prompt: "VSEC_CHILD_CHECK: test the child tool hook using only the prescribed fixture.", subagent_type: "general" } },
      ] : scenario === "patch" ? [
        { tool: "apply_patch", args: { patchText: `*** Begin Patch\n*** Add File: ${join(work, "blocked.ts")}\n+const key = '${CANARY}'\n*** Add File: ${join(work, "atomic.ts")}\n+const safe = true\n*** End Patch` } },
        { tool: "apply_patch", args: { patchText: `*** Begin Patch\n*** Add File: ${join(work, "safe.ts")}\n+export const safe = true\n*** End Patch` } },
      ] : scenario === "code-mode" ? [
        { tool: "execute", args: { code: 'return await tools.probe.save({path: ".env", content: "safe blocked fixture"})' } },
        { tool: "execute", args: { code: 'return await tools.probe.read({path: "observation.txt"})' } },
      ] : [
        { tool: "write", args: { filePath: join(work, "blocked.ts"), content: "const safe = true" } },
        { tool: "probe_save", args: { path: "unknown-side-effect.txt", content: "safe fixture" } },
        { tool: "read", args: { filePath: join(work, "observation.txt") } },
      ]
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST") return new Response("No route", { status: 404 })
        const body = await request.json() as any
        const toolNames = (body.tools ?? []).map((tool: any) => tool.function?.name)
        const lastUser = [...(body.messages ?? [])].reverse().find((message: any) => message.role === "user")
        const child = JSON.stringify(lastUser?.content ?? "").includes("VSEC_CHILD_CHECK")
        const key = child ? "child" : "parent", index = counters.get(key) ?? 0
        const encoded = JSON.stringify(body)
        calls.push({ child, index, tools: toolNames, canaryLeaked: encoded.includes(CANARY), retainedConstraint: encoded.includes("Keep PUBLIC_API."), withheld: encoded.includes("content withheld") })
        if (!toolNames.length) return stream()
        counters.set(key, index + 1)
        if (calls.length > 30) return new Response("Mock request bound reached", { status: 429 })
        const action = child ? index === 0 ? { tool: "write", args: { filePath: join(work, "child-blocked.ts"), content: `const key='${CANARY}'` } } : undefined : actions[index]
        return stream(action)
      } })
      const config = { model: `vsec-local/${model}`, small_model: `vsec-local/${model}`, autoupdate: false, share: "disabled", enabled_providers: ["vsec-local"],
        compaction: { auto: false, prune: false }, lsp: false, formatter: false,
        provider: { "vsec-local": { npm: "@ai-sdk/openai-compatible", name: "Offline fixture", options: { baseURL: `${server.url.origin}/v1`, apiKey: "offline-fixture" },
          models: { [model]: { name: "Offline mock", tool_call: true, limit: { context: 64000, output: 2048 } } } } },
        agent: { build: { steps: 16, model: `vsec-local/${model}` }, general: { model: `vsec-local/${model}`, steps: 4 } },
        permission: { "*": "allow" },
        mcp: { probe: { type: "local", command: [process.execPath, new URL("./security-host-mcp.ts", import.meta.url).pathname, work], enabled: true } },
        plugin: [[new URL("./security-host-plugin.ts", import.meta.url).href, { mode: "off", dataDir: join(sandbox, "bluecode"), security: { mode: "enforce",
          ...(scenario === "scanner-failure" ? { entry: join(sandbox, "crashed.ts") } : {}),
          policy: { mcpTools: scenario === "scanner-failure" ? {} : { probe_save: { operation: "write", pathFields: ["path"], contentFields: ["content"] }, probe_read: { operation: "read", pathFields: ["path"], contentFields: [] } } } } }]],
      }
      if (scenario === "scanner-failure") await writeFile(join(sandbox, "crashed.ts"), "process.exit(1)\n")
      const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true", DO_NOT_TRACK: "1",
        XDG_CONFIG_HOME: join(sandbox, "config"), XDG_DATA_HOME: join(sandbox, "data"), XDG_STATE_HOME: join(sandbox, "state"), XDG_CACHE_HOME: join(root, "cache"),
        VSEC_HOST_TRACE: traceFile, ...(scenario === "code-mode" ? { OPENCODE_EXPERIMENTAL_CODE_MODE: "true" } : {}) }
      const started = performance.now()
      let run
      try { run = await commands.command(["opencode", "run", "--format", "json", "--model", `vsec-local/${model}`, "--title", "VSec offline acceptance", "--dir", work, "Keep PUBLIC_API. Complete the prescribed offline fixture steps."], work, env, 60000) }
      finally { await server.stop(true) }
      const trace = await jsonLines(traceFile), mcp = await jsonLines(join(work, "mcp-executions.jsonl"))
      const checks = { completed: run.code === 0 && !run.timedOut && calls.length > actions.length,
        blockedFileAbsent: !existsSync(join(work, "blocked.ts")), childBlockedFileAbsent: !existsSync(join(work, "child-blocked.ts")),
        noAtomicPartialWrite: !existsSync(join(work, "atomic.ts")), sensitiveFileAbsent: !existsSync(join(work, ".env")),
        unknownSideEffectAbsent: !existsSync(join(work, "unknown-side-effect.txt")), modelCanaryAbsent: calls.every(call => !call.canaryLeaked),
        hooksObserved: trace.length > 0,
        ...(scenario !== "scanner-failure" ? { parentConstraintsRetained: calls.filter(call => !call.child).every(call => call.retainedConstraint) } : {}),
        ...(scenario === "standard" ? { safeEditExecuted: (await readFile(join(work, "safe.ts"), "utf8").catch(() => "")).includes("value = 2"), childHookObserved: new Set(trace.filter(t => t.tool === "write" && t.decision === "blocked").map(t => t.session)).size >= 2, mcpReadExecuted: mcp.some(t => t.name === "read") } : {}),
        ...(scenario === "patch" ? { safePatchExecuted: existsSync(join(work, "safe.ts")) } : {}),
        ...(scenario === "code-mode" ? { nestedMcpBlocked: trace.some(t => t.tool === "probe_save" && t.decision === "blocked"), nestedMcpReadExecuted: mcp.some(t => t.name === "read") } : {}),
        ...(scenario === "scanner-failure" ? { failedEvidenceWithheld: calls.some(call => call.withheld), noMcpSideEffect: mcp.length === 0 } : {}),
      }
      records.push({ scenario, passed: Object.values(checks).every(Boolean), checks, durationMs: performance.now() - started, requests: calls, trace, mcp,
        exitCode: run.code, timedOut: run.timedOut, stderr: run.stderr.replaceAll(CANARY, "[REDACTED]").slice(-3000) })
      const report = { protocol: 1, meta, hostVersion: version, bun: Bun.version, actualLLMCalls: 0, provider: "loopback scripted OpenAI-compatible SSE", compressionMode: "off", securityMode: "enforce", passed: records.length === 4 && records.every(r => r.passed), records }
      await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n")
    }
    return records.every(record => record.passed)
  } finally { await commands.close(); await rm(root, { recursive: true, force: true }) }
}
if (import.meta.main) {
  const output = process.argv[2] ?? "packages/eval/security-host-results.json"
  const passed = await runSecurityHost(output)
  console.log(JSON.stringify({ output, passed }))
  if (!passed) process.exitCode = 1
}
