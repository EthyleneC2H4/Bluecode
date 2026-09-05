import { describe, expect, test } from "bun:test"
import { RtkClient } from "../src/index"
import { objectPath, writeObject } from "@bluecode/shared"
import { writeFile } from "node:fs/promises"
import { lsLaOutput, makeDataDir } from "./helpers"

const HASH_RE = /^sha256:[0-9a-f]{64}$/

describe("compress/fetch full chain", () => {
  test("big ls output compresses and fetch(rawHash) round-trips the original", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("chain") })
    try {
      const input = lsLaOutput(700)
      expect(Buffer.byteLength(input, "utf8")).toBeGreaterThan(512)

      const outcome = await client.compress({ tool: "ls", output: input, sessionId: "sess-a" })
      if (outcome.kind !== "compressed") {
        throw new Error(`expected compressed outcome, got ${JSON.stringify(outcome.kind)}`)
      }

      const { result } = outcome
      expect(result.compressed).toBe(true)
      expect(result.degraded).toBeNull()
      expect(["ls", "grep", "read", "diff", "test", "unknown"]).toContain(result.strategy)
      expect(result.strategy).toBe("ls")
      expect(result.rawHash).toMatch(HASH_RE)
      expect(result.truncated).toBe(false)
      expect(result.rawTokensEst).toBeGreaterThan(512)
      expect(result.output.length).toBeLessThan(input.length)
      // The only non-original bytes allowed are the retrieval footer line.
      expect(result.output).toContain(`[bluecode rtk] compressed: rawHash=${result.rawHash}`)
      expect(result.output).toContain(`headroom_retrieve(hash="${result.rawHash}")`)

      // Round-trip: the sanitized raw text reached the CAS under rawHash.
      const fetched = await client.fetch({ hash: result.rawHash, sessionId: "sess-a" })
      if (fetched.kind !== "found") {
        throw new Error(`expected found outcome, got ${JSON.stringify(fetched)}`)
      }
      let full = fetched.content
      let cursor = fetched.nextCursor
      while (cursor !== null) {
        const next = await client.fetch({ hash: result.rawHash, sessionId: "sess-a", cursor })
        if (next.kind !== "found") throw new Error("missing page")
        full += next.content
        cursor = next.nextCursor
      }
      expect(full).toBe(input)
    } finally {
      await client.shutdown()
    }
  })

  test("fetch is scoped to the session that archived the output", async () => {
    const dataDir = await makeDataDir("ownership")
    const client = await RtkClient.create({ dataDir })
    try {
      const outcome = await client.compress({
        tool: "ls",
        output: lsLaOutput(700),
        sessionId: "sess-owner",
      })
      if (outcome.kind !== "compressed") throw new Error("expected compressed outcome")

      expect(await client.fetch({ hash: outcome.result.rawHash, sessionId: "sess-owner" })).toEqual(
        expect.objectContaining({ kind: "found" })
      )
      expect(await client.fetch({ hash: outcome.result.rawHash, sessionId: "sess-other" })).toEqual(
        { kind: "missing" }
      )
    } finally {
      await client.shutdown()
    }
  })

  test("session ownership survives an rtk server restart", async () => {
    const dataDir = await makeDataDir("ownership-restart")
    const first = await RtkClient.create({ dataDir })
    const outcome = await first.compress({
      tool: "ls",
      output: lsLaOutput(700),
      sessionId: "sess-persisted",
    })
    if (outcome.kind !== "compressed") throw new Error("expected compressed outcome")
    await first.shutdown()

    const second = await RtkClient.create({ dataDir })
    try {
      expect(
        await second.fetch({ hash: outcome.result.rawHash, sessionId: "sess-persisted" })
      ).toEqual(expect.objectContaining({ kind: "found" }))
    } finally {
      await second.shutdown()
    }
  })

  test("legacy CAS objects without ownership stay unavailable", async () => {
    const dataDir = await makeDataDir("legacy-unowned")
    const stored = await writeObject(dataDir, "legacy canonical output")
    const client = await RtkClient.create({ dataDir })
    try {
      expect(
        await client.fetch({
          hash: `sha256:${stored.hash}`,
          sessionId: "sess-legacy",
        })
      ).toEqual({ kind: "missing" })
    } finally {
      await client.shutdown()
    }
  })

  test("owned CAS corruption is rejected instead of returning unverified content", async () => {
    const dataDir = await makeDataDir("owned-corrupt")
    const client = await RtkClient.create({ dataDir })
    try {
      const outcome = await client.compress({
        tool: "ls",
        output: lsLaOutput(700),
        sessionId: "sess-corrupt-object",
      })
      if (outcome.kind !== "compressed") throw new Error("expected compressed outcome")

      const hex = outcome.result.rawHash.slice("sha256:".length)
      await writeFile(objectPath(dataDir, hex), "tampered canonical output")

      await expect(
        client.fetch({
          hash: outcome.result.rawHash,
          sessionId: "sess-corrupt-object",
        })
      ).rejects.toThrow("rtk server error E_INTERNAL")
      expect((await client.ping()).pong).toBe(true)
    } finally {
      await client.shutdown()
    }
  })

  test("fast path below minBytes never reaches the server", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("fast") })
    try {
      const tiny = "src/app.ts:1:tiny output\n"
      expect(Buffer.byteLength(tiny, "utf8")).toBeLessThan(512)

      const outcome = await client.compress({ tool: "grep", output: tiny, sessionId: "sess-fast" })
      expect(outcome).toEqual({
        kind: "passthrough",
        output: tiny,
        degraded: null,
        status: "skipped",
      })

      // The op never crossed the IPC boundary: zero server-side requests.
      const stats = await client.stats()
      expect(stats.requests).toBe(0)
      expect(stats.compressedCount).toBe(0)
      expect(stats.passthroughCount).toBe(0)
    } finally {
      await client.shutdown()
    }
  })

  test("stats counters stay consistent across mixed traffic", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("stats") })
    try {
      const compressed = await client.compress({
        tool: "ls",
        output: lsLaOutput(700),
        sessionId: "sess-stats",
      })
      expect(compressed.kind).toBe("compressed")

      // One more server-visible op through a second big input.
      const second = await client.compress({
        tool: "ls",
        output: lsLaOutput(650),
        sessionId: "sess-stats",
      })
      expect(second.kind).toBe("compressed")

      // Tiny input stays client-side; stats must not count it.
      await client.compress({ tool: "ls", output: "small", sessionId: "sess-stats" })

      const stats = await client.stats()
      expect(stats.requests).toBe(2)
      expect(stats.compressedCount).toBe(2)
      expect(stats.passthroughCount).toBe(0)
      for (const count of Object.values(stats.degradedCounts)) {
        expect(count).toBe(0)
      }
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(0)
    } finally {
      await client.shutdown()
    }
  })

  test("fetch of an unknown hash reports missing instead of failing", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("missing") })
    try {
      const outcome = await client.fetch({
        hash: `sha256:${"a".repeat(64)}`,
        sessionId: "sess-missing",
      })
      expect(outcome).toEqual({ kind: "missing" })
    } finally {
      await client.shutdown()
    }
  })
})
