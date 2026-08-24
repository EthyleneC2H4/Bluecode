/**
 * HeadroomClient behavior: connect-or-spawn against a real bin.ts process,
 * per-request timeout (late frames dropped, connection retained), post-close
 * rejection, spawn argv selection, byte-level handshake framing, boot-fail
 * child cleanup, and frame-overflow teardown.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { FrameOverflowError } from "@bluecode/shared";
import { attemptConnect, daemonSpawnArgv, HeadroomClient } from "../src/client";
import { startHeadroomServer } from "../src/server";

const pkgRoot = path.resolve(import.meta.dir, "..");
const dirs: string[] = [];
const stops: Array<() => void> = [];
const spawnedClients: Array<Promise<HeadroomClient>> = [];

afterAll(async () => {
  for (const promise of spawnedClients) {
    const client = await promise.catch(() => null);
    await client?.close().catch(() => {});
  }
  for (const stop of stops) stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bluecode-hd-cli-"));
  dirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Scripted UDS peer running `script` per connection; closed in afterAll. */
function serve(socketPath: string, script: (sock: net.Socket) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.on("error", () => {}); // client-side destroys surface here
      script(sock);
    });
    stops.push(() => server.close());
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

describe("spawn argv construction", () => {
  test("bun runtime rides execPath through; compiled host falls back to PATH bun; args appended", () => {
    // Real bun runtime: basename check passes, execPath stays.
    expect(daemonSpawnArgv({ entry: "src/bin.ts" }, "/Users/x/.bun/bin/bun")).toEqual([
      "/Users/x/.bun/bin/bun",
      "run",
      "src/bin.ts",
    ]);
    // Compiled host (M7 smoke / devlog #32): execPath is the host binary —
    // must fall back to "bun" from PATH or the daemon never boots.
    expect(daemonSpawnArgv({ entry: "src/bin.ts" }, "/usr/local/bin/opencode")).toEqual([
      "bun",
      "run",
      "src/bin.ts",
    ]);
    // Caller args ride after the interpreter pair, never before it.
    expect(
      daemonSpawnArgv({ entry: "src/bin.ts", args: ["--flag", "v"] }, "/usr/local/bin/opencode"),
    ).toEqual(["bun", "run", "src/bin.ts", "--flag", "v"]);
  });
});

describe("handshake framing (byte-level)", () => {
  test("handshake split across two chunks connects and loses nothing", async () => {
    const socketPath = path.join(await freshDir(), "split.sock");
    await serve(socketPath, (sock) => {
      sock.write('{"proto":1,"pi');
      setTimeout(() => sock.write('d":4242}\n'), 40);
      setTimeout(() => sock.write(`${JSON.stringify({ later: true })}\n`), 140);
    });
    const { socket, pending } = await attemptConnect(socketPath);
    // The handshake straddled two chunks; nothing else had arrived yet.
    expect(pending.length).toBe(0);
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    await sleep(250);
    // The post-handshake frame arrives whole and exactly once.
    expect(received).toBe(`${JSON.stringify({ later: true })}\n`);
    socket.destroy();
  });

  test("handshake plus following frames in one chunk hands them back via pending", async () => {
    const socketPath = path.join(await freshDir(), "combined.sock");
    const first = JSON.stringify({ seq: 1 });
    const second = JSON.stringify({ seq: 2 });
    await serve(socketPath, (sock) => {
      sock.write(`{"proto":1,"pid":7}\n${first}\n${second}\n`);
    });
    const { socket, pending } = await attemptConnect(socketPath);
    // Multi-line-first-chunk: everything past the handshake comes back as
    // unconsumed bytes, byte-identical and in wire order.
    expect(pending.toString("utf8")).toBe(`${first}\n${second}\n`);
    // And they are NOT also re-emitted by the socket (no double delivery).
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    await sleep(80);
    expect(received).toBe("");
    socket.destroy();
  });

  test("incomplete handshake keeps waiting for the timeout instead of failing empty", async () => {
    const socketPath = path.join(await freshDir(), "partial.sock");
    await serve(socketPath, (sock) => {
      sock.write('{"proto":1,'); // never completed by the server
    });
    let thrown: unknown;
    try {
      await attemptConnect(socketPath);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain("connect timeout");
  });
});

describe("connect-or-spawn", () => {
  test("spawns a daemon via the documented recipe and serves requests", async () => {
    const dataDir = await freshDir();
    // Recipe exactly as M5 will use it: entry + cwd; the child takes its
    // dataDir from BLUECODE_DATA_DIR because spawn cannot pass CLI flags.
    const previous = process.env.BLUECODE_DATA_DIR;
    process.env.BLUECODE_DATA_DIR = dataDir;
    try {
      const client = HeadroomClient.connect({
        dataDir,
        spawn: { entry: "src/bin.ts", cwd: pkgRoot },
      });
      spawnedClients.push(client);
      const connected = await client;

      const health = await connected.health();
      expect(health.ok).toBe(true);
      expect(health.sessions).toBe(0);

      // A second client on the SAME socket connects without spawning.
      const second = await HeadroomClient.connect({ dataDir });
      const again = await second.health();
      expect(again.pid).toBe(health.pid);
      await second.close();
    } finally {
      if (previous === undefined) delete process.env.BLUECODE_DATA_DIR;
      else process.env.BLUECODE_DATA_DIR = previous;
    }

    // Cleanup of the spawned daemon: its idle exit is 900s away, so stop it
    // by removing the socket's owner via a health-triggered... simplest:
    // send SIGTERM through the pid file contract.
    const { readFile } = await import("node:fs/promises");
    const pid = Number(await readFile(path.join(dataDir, "headroomd.pid"), "utf8"));
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100 && existsSync(`${dataDir}/headroomd.sock`); i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(existsSync(`${dataDir}/headroomd.sock`)).toBe(false); // SIGTERM cleanup
  });

  test("connect throws when no daemon and no spawn recipe", async () => {
    const dataDir = await freshDir();
    let thrown: unknown;
    try {
      await HeadroomClient.connect({ dataDir });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("cannot connect");
  });

  test("boot failure kills the silent child gracefully — no orphan remains", async () => {
    const workDir = await freshDir(); // holds the fake entry
    const dataDir = await freshDir(); // socket never comes up here → spawn path
    const sentinel = path.join(workDir, "sigterm-sentinel.txt");
    // Fake daemon: prints one non-handshake line, then hangs forever — the
    // exact shape that used to leak the child on the boot-validation reject
    // paths. It writes a sentinel ONLY from its SIGTERM handler, so the
    // sentinel's existence proves fail() killed it via graceful SIGTERM and
    // the child actually exited (no orphan, no event-loop pin).
    await writeFile(
      path.join(workDir, "silent-daemon.ts"),
      [
        `import { writeFileSync } from "node:fs";`,
        `process.on("SIGTERM", () => {`,
        `  const p = process.env.HD_SENTINEL;`,
        `  if (p) writeFileSync(p, String(process.pid));`,
        `  process.exit(0);`,
        `});`,
        `process.stdout.write("starting up, but this is no handshake\\n");`,
        `setInterval(() => {}, 1000);`,
        ``,
      ].join("\n"),
    );
    const previousSentinel = process.env.HD_SENTINEL;
    process.env.HD_SENTINEL = sentinel; // client spreads process.env into the child
    let thrown: unknown;
    try {
      await HeadroomClient.connect({
        socketPath: path.join(dataDir, "absent.sock"),
        spawn: { entry: "silent-daemon.ts", cwd: workDir },
      });
    } catch (err) {
      thrown = err;
    } finally {
      if (previousSentinel === undefined) delete process.env.HD_SENTINEL;
      else process.env.HD_SENTINEL = previousSentinel;
    }
    expect((thrown as Error).message).toContain("no handshake line");

    for (let i = 0; i < 100 && !existsSync(sentinel); i++) {
      await sleep(50);
    }
    expect(existsSync(sentinel)).toBe(true);
  }, 15000);

  test("oversized frame fails in-flight requests with FrameOverflowError and tears down", async () => {
    const socketPath = path.join(await freshDir(), "overflow.sock");
    await serve(socketPath, (sock) => {
      sock.write('{"proto":1,"pid":9}\n');
      setTimeout(() => sock.write("x".repeat(2048)), 40); // unterminated flood frame
    });
    const client = await HeadroomClient.connect({ socketPath, maxFrameBytes: 1024 });
    let err: Error | null = null;
    try {
      await client.health();
    } catch (caught) {
      err = caught as Error;
    }
    expect(err).toBeInstanceOf(FrameOverflowError);
    expect(err?.message).toContain("1024");
    await client.close().catch(() => {});
  });
});

describe("timeouts and lifecycle", () => {
  test("timeout rejects the request, drops late frames, keeps connection usable", async () => {
    const dir = await freshDir();
    const started = await startHeadroomServer({
      dataDir: dir,
      testMode: true,
      responseDelayMs: 400,
    });
    if (started.status !== "listening") throw new Error("expected listening");
    stops.push(started.stop);

    const impatient = await HeadroomClient.connect({ dataDir: dir, timeoutMs: 80 });

    // Times out well before the delayed response arrives.
    let timeoutError: Error | null = null;
    try {
      await impatient.health();
    } catch (err) {
      timeoutError = err as Error;
    }
    expect(timeoutError?.message ?? "").toContain("timed out");

    // The patient client on the same server gets the (delayed) answer fine.
    const patient = await HeadroomClient.connect({ dataDir: dir, timeoutMs: 5000 });
    expect((await patient.health()).ok).toBe(true);

    // The impatient connection was NOT torn down by the timeout — but its
    // per-request budget still applies, so it times out again rather than
    // erroring as closed.
    try {
      await impatient.health();
    } catch (err) {
      expect((err as Error).message).toContain("timed out");
    }

    await patient.close();
    await impatient.close();
  }, 15000);

  test("requests after close reject", async () => {
    const dir = await freshDir();
    const started = await startHeadroomServer({ dataDir: dir });
    if (started.status !== "listening") throw new Error("expected listening");
    stops.push(started.stop);

    const client = await HeadroomClient.connect({ dataDir: dir });
    expect((await client.health()).ok).toBe(true);
    await client.close();

    let thrown: unknown;
    try {
      await client.health();
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain("closed");
  });

  test("server vanishing mid-request fails in-flight requests, not silence", async () => {
    // Real daemon, delayed responses: kill it while a request is outstanding.
    // The close event must surface a connection error to every pending caller
    // instead of leaving them to hang until their timeouts.
    const dir = await freshDir();
    const started = await startHeadroomServer({
      dataDir: dir,
      testMode: true,
      responseDelayMs: 4000,
    });
    if (started.status !== "listening") throw new Error("expected listening");

    const client = await HeadroomClient.connect({ dataDir: dir, timeoutMs: 30000 });

    const inFlight = client.health();
    await sleep(120); // let the request reach the (delayed) server
    started.stop();

    let thrown: unknown;
    try {
      await inFlight;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/connection closed|connection error/);

    // Reap the client without waiting on its now-dead socket.
    await client.close().catch(() => {});
  }, 15000);
});
