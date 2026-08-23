import { describe, expect, test } from "bun:test";
import { RtkClient, VERSION } from "../src/index";
import { bunSpawnArgv } from "../src/client";
import { makeDataDir } from "./helpers";

describe("@bluecode/rtk", () => {
  test("package version export is stable", () => {
    expect(VERSION).toBe("0.0.1");
  });

  test("spawn argv uses execPath only when it is really bun (M7 smoke)", () => {
    // Real bun runtimes: execPath rides along.
    expect(bunSpawnArgv("/x/bin.ts", "/Users/me/.bun/bin/bun")).toEqual([
      "/Users/me/.bun/bin/bun",
      "run",
      "/x/bin.ts",
    ]);
    // Compiled single-file hosts embed bun but their execPath cannot run
    // scripts ("Failed to change directory") — fall back to PATH bun.
    expect(bunSpawnArgv("/x/bin.ts", "/opt/homebrew/bin/opencode")).toEqual([
      "bun",
      "run",
      "/x/bin.ts",
    ]);
    // Windows-style bun binary names still count as real bun.
    expect(bunSpawnArgv("/x/bin.ts", "C:\\tools\\bun-experimental.exe")).toEqual([
      "C:\\tools\\bun-experimental.exe",
      "run",
      "/x/bin.ts",
    ]);
  });

  test("ping round trip completes within 100ms after a warm create()", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("smoke") });
    try {
      expect(client.serverPid).toBeGreaterThan(0);

      const started = performance.now();
      const pong = await client.ping(5000);
      const elapsedMs = performance.now() - started;

      expect(pong.pong).toBe(true);
      expect(pong.uptimeMs).toBeGreaterThanOrEqual(0);
      // Hard completion criterion for the prewarmed-server design.
      expect(elapsedMs).toBeLessThanOrEqual(100);
    } finally {
      await client.shutdown();
    }
  });

  test("shutdown closes the child and makes later requests reject", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("shutdown") });
    await client.ping(5000);
    await client.shutdown();

    expect(client.serverPid).toBeNull();
    await expect(client.compress({ tool: "ls", output: "x".repeat(4096) })).rejects.toThrow(
      /shut down/i,
    );
    // Idempotent: a second shutdown resolves instead of throwing.
    await client.shutdown();
  });
});
