/**
 * HeadroomClient behavior: connect-or-spawn against a real bin.ts process,
 * per-request timeout (late frames dropped, connection retained), and
 * post-close rejection.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HeadroomClient } from "../src/client";
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
});
