import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChatMessage } from "@bluecode/contracts"
import { createEngine, type Engine } from "../src/engine"
import { contentHash, splitTurns } from "../src/turns"
import { historySummary } from "../src/summarize"
import { materializeCompaction } from "../src/compaction"
import { readMessageObject, writeMessageObject } from "../src/store/objects"

const roots: string[] = []
const engines: Engine[] = []
afterEach(async () => {
  for (const e of engines.splice(0)) e.close()
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true })
})
const user = (id: string, text: string): ChatMessage => ({
  info: { id, role: "user" },
  parts: [{ type: "text", text }],
})
const assistant = (id: string, text: string): ChatMessage => ({
  info: { id, role: "assistant" },
  parts: [{ type: "text", text }],
})
const params = {
  projectId: "p",
  sessionId: "s",
  contextWindowTokens: 20000,
  targetTokens: 0,
  triggerRatio: 0.7,
  retainRecentTurns: 0,
}
const messages = () => [
  user("u0", "First request. NEVER delete production data. src/auth.ts must remain."),
  assistant(
    "a0",
    "Progress repeated. ".repeat(200) +
      "\nFinal verified result: latefactzebra migration succeeded."
  ),
  user("u1", "next"),
  assistant("a1", "retain me"),
]
async function fresh() {
  const root = await mkdtemp(path.join(tmpdir(), "bluecode-reliable-"))
  roots.push(root)
  const engine = await createEngine({ dataDir: root })
  engines.push(engine)
  return { root, engine }
}

test("hash covers ordered parts, tool status and full text boundaries", async () => {
  const a: ChatMessage = {
    info: { id: "a", role: "assistant" },
    parts: [
      { type: "tool", tool: "bash", state: { status: "running", output: "same" } },
      { type: "text", text: "last" },
    ],
  }
  const b = structuredClone(a)
  ;(b.parts[0] as any).state.status = "error"
  expect(await contentHash(a)).not.toBe(await contentHash(b))
  expect(await contentHash(a)).not.toBe(await contentHash({ ...a, parts: [...a.parts].reverse() }))
})
test("summary preserves user constraints, late outcomes and middle turns", () => {
  const all = messages()
  for (let i = 2; i < 17; i++)
    all.push(user(`u${i}`, `constraint${i}`), assistant(`a${i}`, `verified${i}`))
  const summary = historySummary(splitTurns(all))
  expect(summary).toContain("NEVER delete production data")
  expect(summary).toContain("src/auth.ts")
  expect(summary).toContain("latefactzebra")
  expect(summary).toContain("constraint7")
})
test("plan rejects same IDs with changed content", async () => {
  const { engine } = await fresh()
  const source = messages()
  const plan = await engine.compress({ ...params, messages: source })
  expect(plan.compacted).toBe(true)
  source[0] = user("u0", "CHANGED: abort the previous request")
  expect(materializeCompaction(source, plan).status).toBe("invalid")
})
test("fulltext search finds facts after the old excerpt limit", async () => {
  const { engine } = await fresh()
  await engine.compress({ ...params, messages: messages() })
  const found = await engine.retrieve({
    namespace: { projectId: "p", sessionId: "s" },
    query: "latefactzebra",
    limit: 5,
  })
  expect("hits" in found && found.hits.length > 0).toBe(true)
})
test("verified reader rejects valid JSON with wrong schema or hash", async () => {
  const { root } = await fresh()
  const msg = user("u", "real")
  const hash = await contentHash(msg)
  await writeMessageObject(root, msg, hash)
  const target = path.join(root, "objects", hash.slice(0, 2), hash)
  await writeFile(target, Bun.gzipSync(Buffer.from("{}")))
  await expect(readMessageObject(root, hash)).rejects.toThrow()
})
test("compacted memory survives repeated materialization and compression", async () => {
  const { engine } = await fresh()
  let source = messages()
  for (let i = 0; i < 5; i++) {
    const plan = await engine.compress({ ...params, messages: source })
    expect(plan.compacted).toBe(true)
    source = materializeCompaction(source, plan).messages
    expect(JSON.stringify(source)).toContain("NEVER delete production data")
    source.push(
      user(`n${i}`, `new requirement ${i}`),
      assistant(`r${i}`, "Progress repeated. ".repeat(300)),
      user(`tail${i}`, "continue")
    )
  }
})

test("corrupt derived SQLite is isolated and rebuilt from verified objects", async () => {
  const { root, engine } = await fresh()
  const plan = await engine.compress({ ...params, messages: messages() })
  engine.close()
  engines.splice(engines.indexOf(engine), 1)
  for (const suffix of ["", "-wal", "-shm"])
    await rm(path.join(root, `index.db${suffix}`), { force: true })
  await writeFile(path.join(root, "index.db"), "not sqlite")
  const reopened = await createEngine({ dataDir: root })
  engines.push(reopened)
  const found = await reopened.retrieve({
    namespace: { projectId: "p", sessionId: "s" },
    hash: plan.refs[0]!.contentHash,
  })
  expect("found" in found && found.found).toBe(true)
})

test("persisted views are scoped and survive reopening", async () => {
  const { root, engine } = await fresh()
  const plan = await engine.compress({ ...params, messages: messages() })
  const e = engine as any
  expect(typeof e.setView).toBe("function")
  e.setView({ projectId: "p", sessionId: "s" }, plan)
  expect(e.getView({ projectId: "foreign", sessionId: "s" })).toBeNull()
  engine.close()
  engines.splice(engines.indexOf(engine), 1)
  const reopened = await createEngine({ dataDir: root })
  engines.push(reopened)
  expect((reopened as any).getView({ projectId: "p", sessionId: "s" })?.historyHash).toBe(
    plan.historyHash
  )
})
