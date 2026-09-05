/**
 * Protocol-streak machinery (SIGKILL after 3 consecutive protocol failures)
 * and FrameOverflowError mapping, over REAL child processes via fault-
 * injecting wrapper entries (same pattern as faults.test.ts).
 *
 * Injection is request-driven, never timer-raced, and marker-gated so the
 * FIRST generation pollutes while respawned generations run clean — recovery
 * assertions always observe a healthy child, and a killed client cannot loop
 * kill/restart forever mid-test.
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { RtkClient, RtkServerError } from "../src/index"
import {
  BIN_TS,
  lsLaOutput,
  makeDataDir,
  parseFrame,
  spawnRawServer,
  waitFor,
  type RawServer,
} from "./helpers"

const clientCleanups: Array<() => Promise<void>> = []
function track(client: RtkClient): void {
  clientCleanups.push(() => client.shutdown())
}

afterEach(async () => {
  while (clientCleanups.length > 0) {
    await clientCleanups.pop()?.()
  }
})

/** Absolute paths the generated wrapper needs (tmpdir cannot resolve workspace specifiers). */
const SERVER_TS = path.join(path.dirname(BIN_TS), "server.ts")
const SHARED_JSONL_TS = path.join(
  path.dirname(path.dirname(path.dirname(BIN_TS))),
  "shared",
  "src",
  "jsonl.ts"
)

/**
 * Build a wrapper entry running the real protocol loop plus fault knobs:
 * - BLUECODE_GARBAGE_SCHEDULE="2,0,1": N non-JSON stdout lines around request
 *   #i (BLUECODE_GARBAGE_WHEN=before|after the response, default after).
 * - BLUECODE_OVERSIZE_BURST=N: newline-less 4 KiB chunks fired 30ms apart
 *   after each response — spaced so each lands as its own reader chunk and
 *   counts as its own FrameOverflowError strike.
 * - BLUECODE_CORRUPT_RESULTS=N: rewrite the next N ok:true results to junk
 *   that fails RESULT_SCHEMAS[op] while keeping the envelope valid.
 */
async function makeEntry(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `bluecode-rtk-entry-${name}-`))
  const entry = path.join(dir, "entry.ts")
  const src = `import { createLineReconstructor } from ${JSON.stringify(SHARED_JSONL_TS)};
import { startServer } from ${JSON.stringify(SERVER_TS)};
import { existsSync, writeFileSync } from "node:fs";

const io = {
  writeFrame(line) { process.stdout.write(line); },
  log(message) { process.stderr.write(message + "\\n"); },
};
const testMode = process.env.BLUECODE_TEST === "1";
const delayRaw = Number(process.env.BLUECODE_TEST_DELAY_MS ?? "0");
const server = startServer(io, {
  testMode,
  responseDelayMs: Number.isFinite(delayRaw) && delayRaw > 0 ? delayRaw : 0,
});

// First boot claims the marker; every later generation runs clean.
const marker = process.env.BLUECODE_INJECT_MARKER ?? "";
const active = marker !== "" && !existsSync(marker);
if (active) writeFileSync(marker, "armed");

const schedule = (process.env.BLUECODE_GARBAGE_SCHEDULE ?? "")
  .split(",")
  .filter((s) => s !== "");
const garbageBefore = (process.env.BLUECODE_GARBAGE_WHEN ?? "after") === "before";
const oversize = Number(process.env.BLUECODE_OVERSIZE_BURST ?? "0");
let corruptLeft = Number(process.env.BLUECODE_CORRUPT_RESULTS ?? "0");
let reqIdx = 0;

function corrupt(line) {
  if (corruptLeft <= 0) return line;
  let frame;
  try { frame = JSON.parse(line); } catch { return line; }
  if (frame.ok !== true) return line;
  corruptLeft -= 1;
  frame.result = { injected: "schema violation" };
  return JSON.stringify(frame) + "\\n";
}

function emitGarbage(n) {
  for (let i = 0; i < n; i++) {
    process.stdout.write("rtk-garbage not-json " + reqIdx + "/" + i + "\\n");
  }
}

function fireOversize(count) {
  void (async () => {
    for (let i = 0; i < count; i++) {
      process.stdout.write("o".repeat(4096));
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
}

const rawWrite = io.writeFrame.bind(io);
io.writeFrame = (line) => rawWrite(corrupt(line));

const frames = createLineReconstructor();
const decoder = new TextDecoder();

try {
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of frames.push(decoder.decode(chunk, { stream: true }))) {
      const n = active
        ? Number(schedule[Math.min(reqIdx, Math.max(schedule.length - 1, 0))] ?? "0")
        : 0;
      reqIdx += 1;
      if (n > 0 && garbageBefore) emitGarbage(n);
      await server.handleLine(line);
      if (n > 0 && !garbageBefore) emitGarbage(n);
      if (active && oversize > 0) fireOversize(oversize);
    }
  }
} catch (err) {
  process.stderr.write("[inject-wrapper] stdin error: " + String(err) + "\\n");
}
for (const l of frames.flush()) await server.handleLine(l);
process.exit(0);
`
  await writeFile(entry, src)
  return entry
}

describe("protocol streak machinery", () => {
  test("(a) three consecutive non-JSON frames SIGKILL the child; backoff restart recovers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bluecode-rtk-marker-streak-"))
    const client = await RtkClient.create({
      dataDir: await makeDataDir("streak"),
      entry: await makeEntry("streak"),
      serverEnv: {
        BLUECODE_INJECT_MARKER: path.join(dir, "marker"),
        BLUECODE_GARBAGE_SCHEDULE: "3",
      },
      timeoutMs: 2000,
    })
    track(client)

    // The garbage rides out after the pong, so this ping resolves normally;
    // the three strikes land right behind it.
    await expect(client.ping(2000)).resolves.toMatchObject({ pong: true })
    await waitFor(() => client.serverPid === null, 4000, "garbage streak did not kill the child")

    // First backoff step is 250ms; the restarted generation is marker-blocked
    // from injecting, so it stays up.
    await waitFor(() => client.serverPid !== null, 5000, "server did not restart")
    expect(client.diag.breakerOpen).toBe(false)
    expect(client.diag.recoveries).toBeGreaterThanOrEqual(1)
    const pong = await client.ping(3000)
    expect(pong.pong).toBe(true)
  }, 20_000)

  test("(a) garbage striking an in-flight compress degrades as crash, never protocol", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bluecode-rtk-marker-crash-"))
    // before-response garbage hits while the compress is still being handled
    // (3s artificial latency), so the kill lands mid-request.
    const client = await RtkClient.create({
      dataDir: await makeDataDir("streakcrash"),
      entry: await makeEntry("streakcrash"),
      serverEnv: {
        BLUECODE_INJECT_MARKER: path.join(dir, "marker"),
        BLUECODE_GARBAGE_SCHEDULE: "3",
        BLUECODE_GARBAGE_WHEN: "before",
        BLUECODE_TEST_DELAY_MS: "3000",
      },
      testMode: true,
      timeoutMs: 8000,
    })
    track(client)

    const input = lsLaOutput(700)
    const inFlight = client.compress({ tool: "ls", output: input, sessionId: "sess-streak-crash" })
    // Non-JSON frames are counted as garbage with NO victim request attached;
    // the in-flight compress only learns of the death via onChildExit, which
    // rejects everything as "crash".
    const outcome = await inFlight
    expect(outcome).toEqual({
      kind: "passthrough",
      output: input,
      degraded: "crash",
      status: "degraded",
    })

    await waitFor(() => client.serverPid !== null, 5000, "server did not restart")
    expect(client.diag.recoveries).toBeGreaterThanOrEqual(1)
  }, 20_000)

  test("(b) schema-invalid result for the live request degrades exactly that request as protocol", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bluecode-rtk-marker-corrupt-"))
    const client = await RtkClient.create({
      dataDir: await makeDataDir("corrupt"),
      entry: await makeEntry("corrupt"),
      serverEnv: {
        BLUECODE_INJECT_MARKER: path.join(dir, "marker"),
        BLUECODE_CORRUPT_RESULTS: "1",
      },
      timeoutMs: 2000,
    })
    track(client)

    const input = lsLaOutput(700)
    const outcome = await client.compress({ tool: "ls", output: input, sessionId: "sess-corrupt" })
    expect(outcome).toEqual({
      kind: "passthrough",
      output: input,
      degraded: "protocol",
      status: "degraded",
    })

    // Strike 1 of 3: the child stays up and id-correlation is undamaged.
    expect(client.serverPid).not.toBeNull()
    expect(client.diag.breakerOpen).toBe(false)
    const next = await client.compress({
      tool: "ls",
      output: lsLaOutput(650),
      sessionId: "sess-corrupt",
    })
    expect(next.kind).toBe("compressed")
  }, 20_000)

  test("reset rule: 2 garbage + well-formed ok:false + 1 garbage never kills", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bluecode-rtk-marker-reset-"))
    const client = await RtkClient.create({
      dataDir: await makeDataDir("reset"),
      entry: await makeEntry("reset"),
      serverEnv: {
        BLUECODE_INJECT_MARKER: path.join(dir, "marker"),
        BLUECODE_GARBAGE_SCHEDULE: "2,0,1",
      },
      timeoutMs: 2000,
    })
    track(client)
    const pidBefore = client.serverPid
    expect(pidBefore).not.toBeNull()

    // req #0 -> pong + 2 garbage: streak climbs to 2, under the kill bar.
    await expect(client.ping(2000)).resolves.toMatchObject({ pong: true })
    expect(client.serverPid).toBe(pidBefore)

    // req #1 -> E_INVALID_PARAMS ok:false: well-formed error traffic resets
    // the streak to 0 (a caller bug, not transport corruption). The bogus
    // field must ride a VALID output string so the client fast path forwards
    // it instead of tripping on its own pre-check.
    await expect(
      client.compress({
        tool: 12345 as unknown as string,
        output: lsLaOutput(700),
        sessionId: "sess-reset",
      })
    ).rejects.toBeInstanceOf(RtkServerError)
    expect(client.serverPid).toBe(pidBefore)

    // req #2 -> pong + 1 garbage: streak stands at 1; no kill anywhere.
    await expect(client.ping(2000)).resolves.toMatchObject({ pong: true })
    expect(client.serverPid).toBe(pidBefore)
    expect(client.diag.breakerOpen).toBe(false)
  }, 20_000)

  test("timeout contract pin: three timeouts alone cannot kill the child (late-reply ring)", async () => {
    // Policy under test (docstring): a timed-out request's late reply is
    // dropped via the late-reply ring WITHOUT feeding the streak — slowness
    // is not corruption. Before the ring existed, these three late replies
    // accumulated a full kill-streak against a perfectly healthy child.
    const client = await RtkClient.create({
      dataDir: await makeDataDir("slowx3"),
      testMode: true,
      serverEnv: { BLUECODE_TEST_DELAY_MS: "300" },
      timeoutMs: 50,
    })
    track(client)
    const pidBefore = client.serverPid
    expect(pidBefore).not.toBeNull()

    for (let i = 0; i < 3; i++) {
      const outcome = await client.compress({
        tool: "ls",
        output: lsLaOutput(700),
        sessionId: "sess-slowx3",
      })
      expect(outcome).toEqual({
        kind: "passthrough",
        output: lsLaOutput(700),
        degraded: "timeout",
        status: "degraded",
      })
      // Let the late reply arrive and be dropped before the next round.
      await new Promise((resolve) => setTimeout(resolve, 400))
    }

    expect(client.serverPid).toBe(pidBefore) // same child, never restarted
    expect(client.diag.recoveries).toBe(0)
    expect(client.diag.breakerOpen).toBe(false)
    await expect(client.ping(2000)).resolves.toMatchObject({ pong: true })
  }, 20_000)
})

describe("FrameOverflowError mapping", () => {
  test("server side: oversized stdin frame answers best-effort E_PROTOCOL then exits 0", async () => {
    const server: RawServer = await spawnRawServer({
      BLUECODE_TEST: "1",
      BLUECODE_MAX_FRAME_BYTES: "64",
    })
    await server.stdout.readLine() // hello

    // 100 newline-less bytes vs a 64-byte ceiling: push() throws inside the
    // entry loop before any framing can resume.
    server.proc.stdin.write("x".repeat(100))
    const response = parseFrame<{ id: string; ok: boolean; error: { code: string } }>(
      await server.stdout.readLine()
    )
    expect(response.ok).toBe(false)
    expect(response.error.code).toBe("E_PROTOCOL")
    expect(await server.exited()).toBe(0)
  }, 10_000)

  test("client side: oversized response frames count as protocol strikes and kill at three", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bluecode-rtk-marker-oversize-"))
    const client = await RtkClient.create({
      dataDir: await makeDataDir("oversize"),
      entry: await makeEntry("oversize"),
      serverEnv: { BLUECODE_INJECT_MARKER: path.join(dir, "marker"), BLUECODE_OVERSIZE_BURST: "3" },
      maxFrameBytes: 2048,
      timeoutMs: 4000,
    })
    track(client)

    // The compress response itself is well-formed and resolves; the three
    // newline-less 4KiB chunks behind it trip FrameOverflowError once each.
    const outcome = await client.compress({
      tool: "ls",
      output: lsLaOutput(700),
      sessionId: "sess-oversize",
    })
    expect(outcome.kind).toBe("compressed")

    await waitFor(() => client.serverPid === null, 5000, "overflow strikes did not kill the child")
    await waitFor(() => client.serverPid !== null, 5000, "server did not restart")
    expect(client.diag.breakerOpen).toBe(false)
    expect(client.diag.recoveries).toBeGreaterThanOrEqual(1)
    await expect(client.ping(3000)).resolves.toMatchObject({ pong: true })
  }, 20_000)
})
