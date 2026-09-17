import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { RtkClient } from "@bluecode/rtk/client"
import { VsecClient } from "@bluecode/vsecagent/client"
import { createEngine } from "@bluecode/headroomd"
import { headroomCompressParamsSchema } from "@bluecode/contracts"
import { createPluginRuntime } from "../src/runtime"
import { parseOptions } from "../src/config"
import { securityDataDir } from "../src/security"
import type { HostMessage } from "../src/host-adapter"

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
async function inspectFiles(dir: string) {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const target = join(dir, file.name)
    if (file.isDirectory()) await inspectFiles(target)
    else if (file.isFile()) {
      const data = await readFile(target)
      const decoded = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data
      expect(decoded.includes(Buffer.from(SECRET))).toBe(false)
    }
  }
}

test("real scanner filters evidence before RTK CAS, headroom CAS/FTS and retrieval", async () => {
  const root = await mkdtemp(join(tmpdir(), "vsec-chain-"))
  const options = parseOptions({ dataDir: root, security: { mode: "enforce" }, rtk: { timeoutMs: 2000 },
    headroom: { strategy: "layered", retainRecentTurns: 1 } })
  const safeDir = securityDataDir(options)
  const scanner = await VsecClient.create({ dataDir: join(safeDir, "audit") })
  const rtk = await RtkClient.create({ dataDir: join(safeDir, "rtk"), timeoutMs: 2000, minBytes: 0 })
  const engine = await createEngine({ dataDir: join(safeDir, "headroom"), securityPolicy: options.security.policy })
  const runtime = createPluginRuntime({ projectId: "p", directory: root, options, security: scanner, rtk,
    headroom: { compress: params => engine.compress(headroomCompressParamsSchema.parse(params)), retrieve: engine.retrieve,
      getView: async ns => engine.getView(ns), setView: async (ns, plan) => engine.setView(ns, plan),
      clearView: async ns => engine.clearView(ns), close: async () => engine.close() } })
  try {
    const output: any = { output: `PASS src/test.ts\n${"  ✓ compatible result\n".repeat(400)}token=${SECRET}\nTests: 400 passed`, metadata: { detail: SECRET } }
    await runtime.toolAfter({ tool: "bash", sessionID: "s", callID: "rtk", args: { command: "bun test", detail: SECRET } }, output)
    expect(JSON.stringify(output)).not.toContain(SECRET)
    expect(output.metadata.bluecode.rawHash).toMatch(/^sha256:/)
    const recovered = await rtk.fetch({ hash: output.metadata.bluecode.rawHash, sessionId: JSON.stringify(["p", "s"]), maxTokens: 2048, maxBytes: 8192 })
    expect(JSON.stringify(recovered)).not.toContain(SECRET)
    const history: HostMessage[] = Array.from({ length: 8 }, (_, i) => [
      { info: { id: `u${i}`, role: "user", sessionID: "s" }, parts: [{ type: "text", text: `Keep API ${i}. Credential ${SECRET}` }] },
      { info: { id: `a${i}`, role: "assistant", sessionID: "s" }, parts: [{ type: "tool", tool: "read", callID: `read${i}`,
        state: { status: "completed", input: { filePath: `src/${i}.ts`, token: SECRET }, output: `const value${i} = 1;\n`.repeat(200) + SECRET } }] },
    ]).flat()
    runtime.observeModel("s", { providerID: "mock", id: "mock", limit: { context: 8000, input: 7000, output: 1000 } })
    const visible = { messages: history }
    await runtime.transform(visible); await runtime.drain()
    expect(JSON.stringify(visible)).not.toContain(SECRET)
    expect(visible.messages[0]!.parts[0]!.text).toContain("Keep API 0.")
    const plan = engine.getView({ projectId: "p", sessionId: "s" })
    expect(plan?.compacted).toBe(true)
    const retrieval = await runtime.sanitizeRetrieval("s", await engine.retrieve({ namespace: { projectId: "p", sessionId: "s" }, historyHash: plan!.historyHash! }))
    expect(JSON.stringify(retrieval)).not.toContain(SECRET)
    expect(runtime.securityStats().redactions).toBeGreaterThan(0)
    await inspectFiles(safeDir)
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 15000)
