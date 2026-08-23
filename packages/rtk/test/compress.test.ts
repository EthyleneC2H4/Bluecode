import { describe, expect, test } from "bun:test";
import { RtkClient } from "../src/index";
import { lsLaOutput, makeDataDir } from "./helpers";

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

describe("compress/fetch full chain", () => {
  test("big ls output compresses and fetch(rawHash) round-trips the original", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("chain") });
    try {
      const input = lsLaOutput(700);
      expect(Buffer.byteLength(input, "utf8")).toBeGreaterThan(512);

      const outcome = await client.compress({ tool: "ls", output: input });
      if (outcome.kind !== "compressed") {
        throw new Error(`expected compressed outcome, got ${JSON.stringify(outcome.kind)}`);
      }

      const { result } = outcome;
      expect(result.compressed).toBe(true);
      expect(result.degraded).toBeNull();
      expect(["ls", "grep", "read", "diff", "test", "unknown"]).toContain(result.strategy);
      expect(result.strategy).toBe("ls");
      expect(result.rawHash).toMatch(HASH_RE);
      expect(result.truncated).toBe(false);
      expect(result.rawTokensEst).toBeGreaterThan(512);
      expect(result.output.length).toBeLessThan(input.length);
      // The only non-original bytes allowed are the retrieval footer line.
      expect(result.output).toContain(
        `[bluecode rtk] compressed: rawHash=${result.rawHash}`,
      );
      expect(result.output).toContain(`headroom_retrieve(hash="${result.rawHash}")`);

      // Round-trip: the sanitized raw text reached the CAS under rawHash.
      const fetched = await client.fetch(result.rawHash);
      if (fetched.kind !== "found") {
        throw new Error(`expected found outcome, got ${JSON.stringify(fetched)}`);
      }
      expect(fetched.content).toBe(input);
    } finally {
      await client.shutdown();
    }
  });

  test("fast path below minBytes never reaches the server", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("fast") });
    try {
      const tiny = "src/app.ts:1:tiny output\n";
      expect(Buffer.byteLength(tiny, "utf8")).toBeLessThan(512);

      const outcome = await client.compress({ tool: "grep", output: tiny });
      expect(outcome).toEqual({
        kind: "passthrough",
        output: tiny,
        degraded: null,
      });

      // The op never crossed the IPC boundary: zero server-side requests.
      const stats = await client.stats();
      expect(stats.requests).toBe(0);
      expect(stats.compressedCount).toBe(0);
      expect(stats.passthroughCount).toBe(0);
    } finally {
      await client.shutdown();
    }
  });

  test("stats counters stay consistent across mixed traffic", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("stats") });
    try {
      const compressed = await client.compress({ tool: "ls", output: lsLaOutput(700) });
      expect(compressed.kind).toBe("compressed");

      // One more server-visible op through a second big input.
      const second = await client.compress({ tool: "ls", output: lsLaOutput(650) });
      expect(second.kind).toBe("compressed");

      // Tiny input stays client-side; stats must not count it.
      await client.compress({ tool: "ls", output: "small" });

      const stats = await client.stats();
      expect(stats.requests).toBe(2);
      expect(stats.compressedCount).toBe(2);
      expect(stats.passthroughCount).toBe(0);
      for (const count of Object.values(stats.degradedCounts)) {
        expect(count).toBe(0);
      }
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.shutdown();
    }
  });

  test("fetch of an unknown hash reports missing instead of failing", async () => {
    const client = await RtkClient.create({ dataDir: await makeDataDir("missing") });
    try {
      const outcome = await client.fetch(`sha256:${"a".repeat(64)}`);
      expect(outcome).toEqual({ kind: "missing" });
    } finally {
      await client.shutdown();
    }
  });
});
