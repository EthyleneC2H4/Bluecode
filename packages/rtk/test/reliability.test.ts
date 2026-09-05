import { expect, test } from "bun:test"
import { RtkClient } from "../src/client"
import { createEngine } from "../src/engine"
import { lsLaOutput, makeDataDir } from "./helpers"

test("concurrent compress calls share admission deadline and stale queued calls never send", async () => {
  const client = await RtkClient.create({
    dataDir: await makeDataDir("deadline"),
    testMode: true,
    serverEnv: { BLUECODE_TEST_DELAY_MS: "100" },
    timeoutMs: 40,
  })
  try {
    const start = performance.now()
    const result = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.compress({ tool: "ls", output: lsLaOutput(100), sessionId: "s" })
      )
    )
    expect(performance.now() - start).toBeLessThan(150)
    expect(result.every((r) => r.kind === "passthrough" && r.degraded === "timeout")).toBe(true)
    await Bun.sleep(150)
    expect((await client.stats()).requests).toBe(1)
  } finally {
    await client.shutdown()
  }
})

test("bounded queue rejects overload without sending excess requests", async () => {
  const client = await RtkClient.create({
    dataDir: await makeDataDir("overload"),
    testMode: true,
    serverEnv: { BLUECODE_TEST_DELAY_MS: "100" },
  })
  try {
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        client.compress({ tool: "ls", output: lsLaOutput(100), sessionId: "s" })
      )
    )
    expect(results.some((r) => r.kind === "passthrough" && r.degraded === "overloaded")).toBe(true)
    expect(client.diag.queuedRequests).toBe(0)
    expect(client.diag.queuedBytes).toBe(0)
  } finally {
    await client.shutdown()
  }
})

test("unchanged wire result yields passthrough without degradation", async () => {
  const client = await RtkClient.create({ dataDir: await makeDataDir("unchanged"), timeoutMs: 500 })
  const output = "unstructured content ".repeat(200)
  try {
    const result = await client.compress({ tool: "mystery", output, sessionId: "s" })
    expect(result.kind).toBe("passthrough")
    if (result.kind === "passthrough") {
      expect(result.output).toBe(output)
      expect(result.degraded).toBeNull()
      expect(result.result?.status).toBe("unchanged")
    }
    expect((await client.stats()).passthroughCount).toBe(1)
  } finally {
    await client.shutdown()
  }
})

test("engine fetch paginates losslessly with bounded namespace-bound cursors", async () => {
  const engine = createEngine({ dataDir: await makeDataDir("pages") })
  try {
    const output = lsLaOutput(700)
    const result = await engine.compress({ tool: "ls", output, sessionId: "s" })
    const page = await engine.fetch({
      hash: result.rawHash,
      sessionId: "s",
      maxBytes: 300,
      maxTokens: 100,
    })
    expect(page.found).toBe(true)
    if (!page.found) throw new Error("missing")
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(300)
    expect(page.truncated).toBe(true)
    expect(page.nextCursor).toBeString()
    let text = page.content
    let cursor = page.nextCursor
    while (cursor !== null) {
      const next = await engine.fetch({
        hash: result.rawHash,
        sessionId: "s",
        cursor,
        maxBytes: 2000,
        maxTokens: 512,
      })
      if (!next.found) throw new Error("missing")
      expect(next.content.length).toBeGreaterThan(0)
      expect(next.nextCursor).not.toBe(cursor)
      text += next.content
      cursor = next.nextCursor
    }
    expect(text).toBe(output)
    await expect(
      engine.fetch({ hash: result.rawHash, sessionId: "s", cursor: "garbage" })
    ).rejects.toThrow()
  } finally {
    engine.close()
  }
})

test("storage quota fails open and preserves every previously published reference", async () => {
  const engine = createEngine({ dataDir: await makeDataDir("quota"), maxStorageBytes: 8000 })
  try {
    const output = lsLaOutput(70)
    const first = await engine.compress({ tool: "ls", output, sessionId: "s" })
    expect(first.compressed).toBe(true)
    const second = await engine.compress({ tool: "ls", output: lsLaOutput(200), sessionId: "s" })
    expect(second.status).toBe("degraded")
    expect(second.degraded?.reason).toBe("storage_capacity")
    expect(second.output).toBe(lsLaOutput(200))
    expect((await engine.fetch({ hash: first.rawHash, sessionId: "s" })).found).toBe(true)
  } finally {
    engine.close()
  }
})

test("retrieval uses its own deadline while timed-out compression is draining", async () => {
  const dir = await makeDataDir("retrieval-timeout")
  const engine = createEngine({ dataDir: dir })
  const archived = await engine.compress({ tool: "ls", output: lsLaOutput(70), sessionId: "s" })
  engine.close()
  const client = await RtkClient.create({
    dataDir: dir,
    timeoutMs: 40,
    testMode: true,
    serverEnv: { BLUECODE_TEST_DELAY_MS: "100" },
  })
  try {
    expect(
      (await client.compress({ tool: "ls", output: lsLaOutput(200), sessionId: "s" })).kind
    ).toBe("passthrough")
    const result = await client.fetch({ hash: archived.rawHash, sessionId: "s" })
    expect(result.kind).toBe("found")
  } finally {
    await client.shutdown()
  }
})

test("queue byte ceiling fails open before publishing large input", async () => {
  const client = await RtkClient.create({ dataDir: await makeDataDir("byte-cap") })
  try {
    const result = await client.compress({
      tool: "ls",
      output: "x".repeat(8 * 1024 * 1024),
      sessionId: "s",
    })
    expect(result.kind).toBe("passthrough")
    if (result.kind === "passthrough") expect(result.degraded).toBe("overloaded")
    expect((await client.stats()).requests).toBe(0)
  } finally {
    await client.shutdown()
  }
})

test("queued requests belong to their original child generation", async () => {
  const client = await RtkClient.create({
    dataDir: await makeDataDir("generation"),
    timeoutMs: 1000,
    testMode: true,
    serverEnv: { BLUECODE_TEST_DELAY_MS: "300" },
  })
  try {
    const calls = Array.from({ length: 8 }, () =>
      client.compress({ tool: "ls", output: lsLaOutput(70), sessionId: "s" })
    )
    await Bun.sleep(20)
    process.kill(client.serverPid!, "SIGKILL")
    const results = await Promise.all(calls)
    expect(results.every((result) => result.kind === "passthrough")).toBe(true)
    await Bun.sleep(500)
    expect((await client.stats()).requests).toBe(0)
  } finally {
    await client.shutdown()
  }
})
