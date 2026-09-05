/**
 * Fault injection with REAL process operations (SIGKILL, file removal,
 * delayed responses) — no mocks. This is the acceptance point for "the
 * process boundary and its failure isolation actually exist".
 */
import { mkdtemp, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { RtkClient } from "../src/index"
import { BIN_TS, lsLaOutput, makeDataDir, waitFor } from "./helpers"

describe("fault injection", () => {
  test("a) SIGKILL during an in-flight compress -> crash, then auto-restart serves the next request", async () => {
    // 3s artificial response latency keeps the request in flight until we kill.
    const client = await RtkClient.create({
      dataDir: await makeDataDir("crash"),
      timeoutMs: 8000,
      testMode: true,
      serverEnv: { BLUECODE_TEST_DELAY_MS: "3000" },
    })
    try {
      const input = lsLaOutput(700)
      const inFlight = client.compress({ tool: "ls", output: input, sessionId: "sess-crash" })
      await new Promise((resolve) => setTimeout(resolve, 150)) // let it reach the server

      expect(client.serverPid).not.toBeNull()
      process.kill(client.serverPid as number, "SIGKILL")

      const outcome = await inFlight
      expect(outcome).toEqual({
        kind: "passthrough",
        output: input,
        degraded: "crash",
        status: "degraded",
      })

      // First backoff step is 250ms; wait out the restart cycle.
      await waitFor(() => client.serverPid !== null, 4000, "server did not restart")
      expect(client.diag.recoveries).toBeGreaterThanOrEqual(1)

      const next = await client.compress({ tool: "ls", output: input, sessionId: "sess-crash" })
      expect(next.kind).toBe("compressed")
    } finally {
      await client.shutdown()
    }
  }, 20_000)

  test("b) exhausting restarts opens the breaker; probes recover it once the server is back", async () => {
    // Wrapper entry so respawn-ability can be revoked on disk without
    // touching package sources: deleting the wrapper makes every spawn fail.
    const wrapperDir = await mkdtemp(path.join(tmpdir(), "bluecode-rtk-wrapper-"))
    const entry = path.join(wrapperDir, "entry.ts")
    await writeFile(entry, `import ${JSON.stringify(BIN_TS)};\n`)

    const client = await RtkClient.create({
      dataDir: await makeDataDir("breaker"),
      entry,
      maxRestartAttempts: 2,
      probeIntervalMs: 50,
      timeoutMs: 2000,
    })

    try {
      const input = lsLaOutput(700)
      expect(
        (await client.compress({ tool: "ls", output: input, sessionId: "sess-breaker" })).kind
      ).toBe("compressed")

      // Kill #1: restart budget still healthy, backoff window rejects fast.
      process.kill(client.serverPid as number, "SIGKILL")
      await waitFor(() => client.serverPid === null, 2000)
      const t0 = Date.now()
      const duringBackoff = await client.compress({
        tool: "ls",
        output: input,
        sessionId: "sess-breaker",
      })
      expect(duringBackoff).toEqual({
        kind: "passthrough",
        output: input,
        degraded: "spawn_failed",
        status: "degraded",
      })
      expect(Date.now() - t0).toBeLessThan(1000) // failed fast, no spawn attempt
      await waitFor(() => client.serverPid !== null, 4000)

      // Kill #2 after revoking the entry: both restart attempts fail ->
      // breaker opens and requests keep failing fast without any spawn.
      await rename(entry, `${entry}.revoked`)
      process.kill(client.serverPid as number, "SIGKILL")
      await waitFor(() => client.serverPid === null, 2000)
      await waitFor(() => client.diag.breakerOpen, 8000, "breaker did not open")

      const broken = await client.compress({ tool: "ls", output: input, sessionId: "sess-breaker" })
      expect(broken).toEqual({
        kind: "passthrough",
        output: input,
        degraded: "spawn_failed",
        status: "degraded",
      })
      const spawnsAtTrip = client.diag.spawns
      await client.compress({ tool: "ls", output: input, sessionId: "sess-breaker" })
      // Request path must not spawn; only background probes may have.
      const probeSpawns = client.diag.spawns - spawnsAtTrip
      expect(probeSpawns).toBeLessThanOrEqual(2) // one probe tick at most

      // Restore the server entry; the next probe succeeds and closes the breaker.
      await rename(`${entry}.revoked`, entry)
      await waitFor(() => !client.diag.breakerOpen, 5000, "breaker did not recover")
      await waitFor(() => client.serverPid !== null, 4000)
      expect(client.diag.recoveries).toBeGreaterThanOrEqual(1)

      const recovered = await client.compress({
        tool: "ls",
        output: input,
        sessionId: "sess-breaker",
      })
      expect(recovered.kind).toBe("compressed")
    } finally {
      await client.shutdown()
    }
  }, 30_000)

  test("d) slow response times out, late frame is discarded, connection stays usable", async () => {
    const client = await RtkClient.create({
      dataDir: await makeDataDir("slow"),
      testMode: true,
      serverEnv: { BLUECODE_TEST_DELAY_MS: "200" },
      timeoutMs: 40,
    })
    try {
      const input = lsLaOutput(700)
      const started = performance.now()
      const outcome = await client.compress({ tool: "ls", output: input, sessionId: "sess-slow" })
      const elapsed = performance.now() - started

      expect(outcome).toEqual({
        kind: "passthrough",
        output: input,
        degraded: "timeout",
        status: "degraded",
      })
      expect(elapsed).toBeLessThan(1000)

      // The compress response is still in flight (200ms delay); give it time
      // to arrive, then confirm it was dropped by id instead of polluting
      // the next exchange.
      await new Promise((resolve) => setTimeout(resolve, 250))
      const pong = await client.ping(2000)
      expect(pong.pong).toBe(true)
      expect(client.diag.breakerOpen).toBe(false)
    } finally {
      await client.shutdown()
    }
  }, 10_000)
})
