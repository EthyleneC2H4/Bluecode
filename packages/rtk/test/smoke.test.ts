import { describe, expect, test } from "bun:test";
import { RtkClient, VERSION } from "../src/index";
import { makeDataDir } from "./helpers";

describe("@bluecode/rtk", () => {
  test("package version export is stable", () => {
    expect(VERSION).toBe("0.0.1");
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
