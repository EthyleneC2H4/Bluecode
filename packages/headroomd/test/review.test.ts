import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createEngine, type Engine } from "../src/engine"
import { migrateLegacyHeadroom } from "../src/migration"
import { storageBytes } from "../src/store/quota"
import type { ChatMessage } from "@bluecode/contracts"
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "hr-review-"))
  let engine = await createEngine({ dataDir: dir })
  cleanup.push(async () => {
    engine.close()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    dir,
    engine,
    reopen: async () => {
      engine.close()
      engine = await createEngine({ dataDir: dir })
      return engine
    },
  }
}
function messages(prefix = ""): ChatMessage[] {
  return [
    {
      info: { id: `${prefix}u`, role: "user" },
      parts: [{ type: "text", text: "Keep the authentication guard." }],
    },
    {
      info: { id: `${prefix}a`, role: "assistant" },
      parts: [
        { type: "text", text: "Searchable route.\n".repeat(500) + "latefactzebra final outcome" },
      ],
    },
    { info: { id: `${prefix}tail`, role: "user" }, parts: [{ type: "text", text: "Continue" }] },
  ]
}
function params(prefix = "") {
  return {
    projectId: "old",
    sessionId: "s",
    messages: messages(prefix),
    retainRecentTurns: 0,
    contextWindowTokens: 10000,
    targetTokens: 0,
    triggerRatio: 0.7,
  }
}

test("one durable root has one writer even with distinct sockets", async () => {
  const { dir } = await setup()
  await expect(createEngine({ dataDir: dir })).rejects.toThrow(/writer|locked/i)
})
test("new candidate epoch cannot rewrite the published active view", async () => {
  const { engine } = await setup()
  const a = await engine.compress({ ...params(), epoch: "A" })
  engine.setView({ projectId: "old", sessionId: "s" }, a)
  await engine.compress({ ...params(), epoch: "B" })
  expect(engine.getView({ projectId: "old", sessionId: "s" })?.epoch).toBe("A")
})
test("query cursor rejects changed ranked evidence instead of splicing another hit", async () => {
  const { engine } = await setup()
  await engine.compress(params())
  const query = {
    namespace: { projectId: "old", sessionId: "s" },
    query: "Searchable",
    limit: 5,
    maxBytes: 100,
    maxTokens: 100,
  }
  const first = await engine.retrieve(query)
  if (!("hits" in first) || !first.nextCursor) throw new Error("missing cursor")
  await engine.compress(params("second"))
  await expect(engine.retrieve({ ...query, cursor: first.nextCursor })).rejects.toThrow(
    /cursor|reference|snapshot/i
  )
})
test("loss of a late fulltext segment triggers complete index recovery", async () => {
  const { engine, dir, reopen } = await setup()
  await engine.compress(params())
  engine.close()
  const db = new Database(join(dir, "index.db"))
  const row = db.query("SELECT id FROM segments ORDER BY start_offset DESC LIMIT 1").get() as any
  db.query("DELETE FROM segment_fts WHERE id=?").run(row.id)
  db.query("DELETE FROM segments WHERE id=?").run(row.id)
  db.close()
  const restored = await reopen()
  const result = await restored.retrieve({
    namespace: { projectId: "old", sessionId: "s" },
    query: "latefactzebra",
  })
  expect("hits" in result && result.hits.length > 0).toBe(true)
})
test("offline migration remaps explicit project ownership only in the copy", async () => {
  const { engine, dir } = await setup()
  const plan = await engine.compress(params())
  engine.close()
  const before = await readFile(join(dir, "meta.db"))
  const result = await migrateLegacyHeadroom({
    dataDir: dir,
    offline: true,
    projectMappings: { old: "new" },
  } as any)
  const migrated = await createEngine({ dataDir: result.dataDir })
  try {
    const found = await migrated.retrieve({
      namespace: { projectId: "new", sessionId: "s" },
      hash: plan.refs[0]!.contentHash,
    })
    expect("found" in found && found.found).toBe(true)
    expect(await readFile(join(dir, "meta.db"))).toEqual(before)
  } finally {
    migrated.close()
  }
  expect(
    (await migrateLegacyHeadroom({ dataDir: dir, offline: true, projectMappings: { old: "new" } }))
      .status
  ).toBe("already-migrated")
  await expect(
    migrateLegacyHeadroom({ dataDir: dir, offline: true, projectMappings: { old: "other" } })
  ).rejects.toThrow(/identity|mapping|source/i)
  await expect(
    migrateLegacyHeadroom({
      dataDir: dir,
      legacyDataDir: join(dir, "other-source"),
      offline: true,
      projectMappings: { old: "new" },
    })
  ).rejects.toThrow(/identity|mapping|source/i)
})
test("migration rechecks the completed index against quota before switching", async () => {
  const { engine, dir } = await setup()
  await engine.compress(params())
  engine.close()
  const copiedBytes =
    (
      await Promise.all(
        ["", "-wal", "-shm"].map(
          async (suffix) =>
            (await stat(join(dir, `meta.db${suffix}`)).catch(() => ({ size: 0 }))).size
        )
      )
    ).reduce((a, b) => a + b, 0) + (await storageBytes(join(dir, "objects")))
  await expect(
    migrateLegacyHeadroom({ dataDir: dir, offline: true, maxStorageBytes: copiedBytes + 1024 })
  ).rejects.toThrow(/capacity|quota/i)
})
test("tool argument paths and errors contribute to memory and budget", async () => {
  const { engine } = await setup()
  const p = params()
  p.messages[1]!.parts = [
    {
      type: "tool",
      tool: "edit",
      input: { filePath: "src/payment.ts", command: "npm test" },
      state: { status: "error", error: "Verification failed. ".repeat(400) },
    },
  ]
  const result = await engine.compress(p)
  expect(result.summary).toContain("src/payment.ts")
  expect(result.sourceTokensEst).toBeGreaterThan(1000)
})

test("natural questions search technical terms without requiring grammatical filler", async () => {
  const { engine } = await setup()
  const p = params()
  p.messages[1]!.parts.unshift({ type: "text", text: "Database engine selected: PostgreSQL-17." })
  await engine.compress(p)
  const result = await engine.retrieve({
    namespace: { projectId: "old", sessionId: "s" },
    query: "What was the database engine selected?",
    limit: 5,
  })
  expect("hits" in result && result.hits.some((hit) => hit.snippet.includes("PostgreSQL-17"))).toBe(
    true
  )
})
