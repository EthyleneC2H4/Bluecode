import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import net from "node:net"
import type { ChatMessage } from "@bluecode/contracts"
import { createEngine, type Engine } from "../src/engine"
import { attemptConnect, HeadroomClient } from "../src/client"
import { startHeadroomServer } from "../src/server"
import { renderProjection } from "../src/store/objects"
const roots: string[] = [],
  engines: Engine[] = []
afterEach(async () => {
  for (const e of engines.splice(0)) e.close()
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true })
})
const ns = { projectId: "p", sessionId: "s" }
const opts = {
  ...ns,
  contextWindowTokens: 100000,
  targetTokens: 0,
  triggerRatio: 0.7,
  retainRecentTurns: 0,
}
function source(n = 3): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => [
    {
      info: { id: `u${i}`, role: "user" as const },
      parts: [{ type: "text" as const, text: `requirement ${i}` }],
    },
    {
      info: { id: `a${i}`, role: "assistant" as const },
      parts: [
        {
          type: "text" as const,
          text:
            "Progress repeated. ".repeat(500) +
            "\nLate factual path src/private/zebralate.ts failed pending.",
        },
      ],
    },
  ]).flat()
}
async function fresh(maxStorageBytes?: number) {
  const root = await mkdtemp(path.join(tmpdir(), "hr-continued-"))
  roots.push(root)
  const engine = await createEngine({
    dataDir: root,
    ...(maxStorageBytes !== undefined ? { maxStorageBytes } : {}),
  })
  engines.push(engine)
  return { root, engine }
}
test("hash and history cursor pages never drop long Unicode tails", async () => {
  const { engine } = await fresh()
  const messages = source()
  const plan = await engine.compress({ ...opts, messages })
  const hash = plan.refs[1]!.contentHash
  let cursor: string | undefined,
    text = ""
  do {
    const page = await engine.retrieve({
      namespace: ns,
      hash,
      maxBytes: 83,
      maxTokens: 83,
      ...(cursor ? { cursor } : {}),
    })
    expect("content" in page).toBe(true)
    if (!("content" in page)) break
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(83)
    text += page.content
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(text).toBe(renderProjection(messages[1]!))
  let historyCursor: string | undefined
  const recovered = new Map<string, string>()
  do {
    const page = await engine.retrieve({
      namespace: ns,
      historyHash: plan.historyHash!,
      maxBytes: 101,
      maxTokens: 101,
      ...(historyCursor ? { cursor: historyCursor } : {}),
    })
    if (!("items" in page)) throw Error("missing")
    expect(page.items.reduce((n, x) => n + Buffer.byteLength(x.content), 0)).toBeLessThanOrEqual(
      101
    )
    for (const item of page.items)
      recovered.set(item.contentHash, (recovered.get(item.contentHash) ?? "") + item.content)
    historyCursor = page.nextCursor ?? undefined
  } while (historyCursor)
  expect(recovered.get(hash)).toBe(text)
  await expect(
    engine.retrieve({
      namespace: ns,
      hash,
      cursor: Buffer.from(JSON.stringify({ v: 1, ref: "foreign", offset: 0 })).toString(
        "base64url"
      ),
    })
  ).rejects.toThrow()
})
test("planner keeps four completed turns plus last turn", async () => {
  const { engine } = await fresh()
  const plan = await engine.compress({ ...opts, retainRecentTurns: 4, messages: source(7) })
  expect(plan.replacedMessageIds).toEqual(["u0", "a0", "u1", "a1"])
})
test("query snippets use full content offsets and aggregate page budget", async () => {
  const { engine } = await fresh()
  await engine.compress({ ...opts, messages: source(5) })
  const result = await engine.retrieve({
    namespace: ns,
    query: "zebralate",
    maxBytes: 80,
    maxTokens: 80,
  })
  if (!("hits" in result)) throw Error("missing")
  expect(result.hits.length).toBeGreaterThan(0)
  expect(result.hits.reduce((n, h) => n + Buffer.byteLength(h.snippet), 0)).toBeLessThanOrEqual(80)
  expect(result.hits[0]!.startOffset).toBeGreaterThan(2000)
})
test("capacity failure publishes no archive references", async () => {
  const { engine } = await fresh(1)
  await expect(engine.compress({ ...opts, messages: source() })).rejects.toThrow(/capacity/i)
  expect(engine.sessionCount()).toBe(0)
})
test("handshake EOF rejects immediately without waiting for inactivity timeout", async () => {
  const { root } = await fresh()
  const socketPath = path.join(root, "fake.sock")
  const server = net.createServer((s) => s.end('{"proto":'))
  await new Promise<void>((r) => server.listen(socketPath, r))
  const start = Date.now()
  try {
    await expect(attemptConnect(socketPath)).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(500)
  } finally {
    server.close()
  }
})
test("view IPC persists and validates namespace", async () => {
  const { root } = await fresh()
  const started = await startHeadroomServer({ dataDir: path.join(root, "server"), idleExitMs: 0 })
  if (started.status !== "listening") throw Error("not listening")
  const client = await HeadroomClient.connect({ socketPath: started.socketPath })
  try {
    const plan = await client.compress({ ...opts, messages: source() })
    await client.setView(ns, plan)
    expect((await client.getView(ns))?.historyHash).toBe(plan.historyHash)
    expect(await client.getView({ ...ns, projectId: "foreign" })).toBeNull()
    await client.clearView(ns)
    expect(await client.getView(ns)).toBeNull()
  } finally {
    await client.close()
    started.stop()
    await started.done
  }
})

test("nested histories recover original evidence through twenty generations", async () => {
  const { engine } = await fresh()
  const { materializeCompaction } = await import("../src/compaction")
  let messages = source(3)
  let rootHash = ""
  const firstHash = (await import("../src/turns")).contentDigest(messages[0]!)
  for (let generation = 0; generation < 20; generation++) {
    const plan = await engine.compress({ ...opts, messages })
    expect(plan.compacted).toBe(true)
    rootHash = plan.historyHash!
    if ([1, 4, 19].includes(generation)) {
      expect(
        plan.memory?.some(
          (entry) => entry.text === "requirement 0" && entry.sourceIds.includes("u0")
        )
      ).toBe(true)
      let cursor: string | undefined,
        found = false
      do {
        const page = await engine.retrieve({
          namespace: ns,
          historyHash: rootHash,
          maxTokens: 8192,
          ...(cursor ? { cursor } : {}),
        })
        if (!("items" in page)) throw Error("missing history")
        found ||= page.items.some((item) => item.contentHash === firstHash)
        cursor = page.nextCursor ?? undefined
      } while (cursor && !found)
      expect(found).toBe(true)
    }
    messages = materializeCompaction(messages, plan).messages
    messages.push(
      ...source(2).map((m) => ({ ...m, info: { ...m.info, id: `g${generation}-${m.info.id}` } }))
    )
  }
})

test("offline migration verifies copies and leaves the legacy ledger byte-identical", async () => {
  const { root, engine } = await fresh()
  const plan = await engine.compress({ ...opts, messages: source() })
  engine.close()
  engines.splice(engines.indexOf(engine), 1)
  const { readFile } = await import("node:fs/promises")
  const before = await readFile(path.join(root, "meta.db"))
  const { migrateLegacyHeadroom, createLegacyReader } = await import("../src/migration")
  const reader = createLegacyReader(root)
  try {
    const hit = await reader.retrieve({ namespace: ns, hash: plan.refs[0]!.contentHash })
    expect("found" in hit && hit.found).toBe(true)
    expect(
      await reader.retrieve({
        namespace: { ...ns, sessionId: "foreign" },
        hash: plan.refs[0]!.contentHash,
      })
    ).toEqual({ found: false })
  } finally {
    reader.close()
  }
  const migrated = await migrateLegacyHeadroom({ dataDir: root, offline: true })
  expect(migrated.status).toBe("migrated")
  expect(await readFile(path.join(root, "meta.db"))).toEqual(before)
  const reopened = await createEngine({ dataDir: migrated.dataDir })
  engines.push(reopened)
  expect(
    "found" in (await reopened.retrieve({ namespace: ns, hash: plan.refs[0]!.contentHash }))
  ).toBe(true)
})

test("planner chooses the smallest positive-gain prefix reaching target and protects unknown tools", async () => {
  const { engine } = await fresh()
  const messages = source(7)
  const shortest = await engine.compress({ ...opts, messages: source(2) })
  const { messageTokens } = await import("../src/summarize")
  const total = messages.reduce((sum, m) => sum + messageTokens(m), 0)
  const plan = await engine.compress({
    ...opts,
    messages,
    targetTokens: total - shortest.freedTokens,
  })
  expect(plan.replacedMessageIds).toEqual(["u0", "a0"])
  const blocked = source(7)
  blocked[3]!.parts.push({
    type: "tool",
    tool: "bash",
    state: { status: "unknown", output: "not confirmed" },
  })
  const safe = await engine.compress({ ...opts, messages: blocked, targetTokens: 0 })
  expect(safe.replacedMessageIds).toEqual(["u0", "a0"])
  expect(safe.budgetExceeded).toBe(true)
})
test("absolute handshake deadline cannot be extended by drip-fed data", async () => {
  const { root } = await fresh()
  const socketPath = path.join(root, "drip.sock")
  const server = net.createServer((s) => {
    const timer = setInterval(() => s.write(" "), 30)
    // Deadline expiry closes the peer while the drip timer may still write.
    // Those disconnect errors belong to this fixture, not to the client.
    s.on("error", (error: NodeJS.ErrnoException) => {
      clearInterval(timer)
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") throw error
    })
    s.on("close", () => clearInterval(timer))
  })
  await new Promise<void>((r) => server.listen(socketPath, r))
  const start = Date.now()
  try {
    await expect(attemptConnect(socketPath)).rejects.toThrow(/timeout/)
    expect(Date.now() - start).toBeLessThan(1400)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
test("daemon rejects coalesced requests beyond admission capacity", async () => {
  const { root } = await fresh()
  const server = await startHeadroomServer({ dataDir: path.join(root, "flood"), idleExitMs: 0 })
  if (server.status !== "listening") throw Error("not listening")
  const { socket } = await attemptConnect(server.socketPath)
  try {
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    socket.on("error", () => {})
    socket.write(
      Array.from(
        { length: 33 },
        (_, i) => JSON.stringify({ v: 2, id: `f${i}`, op: "health", params: {} }) + "\n"
      ).join("")
    )
    await closed
  } finally {
    socket.destroy()
    server.stop()
    await server.done
  }
})

test("query cursor preserves truncated snippet tails", async () => {
  const { engine } = await fresh()
  await engine.compress({ ...opts, messages: source() })
  let cursor: string | undefined,
    text = ""
  do {
    const page = await engine.retrieve({
      namespace: ns,
      query: "zebralate",
      limit: 1,
      maxBytes: 29,
      maxTokens: 29,
      ...(cursor ? { cursor } : {}),
    })
    if (!("hits" in page)) throw Error("missing hits")
    text += page.hits.map((h) => h.snippet).join("")
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(text).toContain("src/private/zebralate.ts failed pending.")
})

test("startup preserves a live legacy protocol socket", async () => {
  const { root } = await fresh()
  const socketPath = path.join(root, "headroomd.sock")
  const legacy = net.createServer((s) => {
    s.on("error", () => {})
    s.end('{"proto":1,"pid":7}\n')
  })
  await new Promise<void>((r) => legacy.listen(socketPath, r))
  try {
    await expect(startHeadroomServer({ dataDir: root })).rejects.toThrow(
      /incompatible|replace|protocol/i
    )
    expect((await import("node:fs")).existsSync(socketPath)).toBe(true)
  } finally {
    legacy.close()
  }
})
test("startup GC removes only stale temporary files and preserves live objects", async () => {
  const { root, engine } = await fresh()
  const plan = await engine.compress({ ...opts, messages: source() })
  engine.close()
  engines.splice(engines.indexOf(engine), 1)
  const { writeFile, utimes } = await import("node:fs/promises")
  const stale = path.join(root, ".tmp-abandoned"),
    recent = path.join(root, ".tmp-current")
  await writeFile(stale, "old")
  await writeFile(recent, "current")
  await utimes(stale, new Date(0), new Date(0))
  const reopened = await createEngine({ dataDir: root })
  engines.push(reopened)
  const { existsSync } = await import("node:fs")
  expect(existsSync(stale)).toBe(false)
  expect(existsSync(recent)).toBe(true)
  const hit = await reopened.retrieve({ namespace: ns, hash: plan.refs[0]!.contentHash })
  expect("found" in hit && hit.found).toBe(true)
})
