import { describe, expect, test } from "bun:test";
import type { CompressResult } from "@bluecode/contracts";
import { estimateTokens, sha256Hex } from "@bluecode/shared";
import { DEFAULT_BUDGET_TOKENS, compressToolOutput } from "../src/pipeline";
import { createPipelineStats } from "../src/stats";
import { NOISE, READ_OUT } from "./fixtures";

describe("compressToolOutput — fast path", () => {
  test("within-budget output passes through byte-identically", async () => {
    const raw = "hello world\nsecond line\nthird line";
    const res = await compressToolOutput({ tool: "bash", output: raw });
    expect(res.compressed).toBe(false);
    expect(res.output).toBe(raw); // byte-for-byte
    expect(res.degraded).toBeNull();
    expect(res.rawForStore).toBe(raw);
    expect(res.outTokensEst).toBe(res.rawTokensEst);
    expect(res.truncated).toBe(false);
  });

  test("strategy still reflects classification on the fast path", async () => {
    const res = await compressToolOutput({ tool: "read", output: "tiny" });
    expect(res.strategy).toBe("read");
    const noise = await compressToolOutput({ tool: "bash", output: "just words here" });
    expect(noise.strategy).toBe("unknown");
  });

  test("budgetTokens defaults to 512 like the wire schema", async () => {
    // ~150 tokens < 512 -> fast path.
    const small = await compressToolOutput({ tool: "bash", output: NOISE });
    expect(small.compressed).toBe(false);

    // > 2048 chars (> 512 tokens) -> compression kicks in with the same default.
    const big = await compressToolOutput({ tool: "read", output: READ_OUT });
    expect(big.compressed).toBe(true);
    expect(DEFAULT_BUDGET_TOKENS).toBe(512);
  });

  test("metadata.truncated is forwarded", async () => {
    const yes = await compressToolOutput({
      tool: "bash",
      output: NOISE,
      metadata: { truncated: true },
    });
    expect(yes.truncated).toBe(true);
    const no = await compressToolOutput({
      tool: "bash",
      output: NOISE,
      metadata: { truncated: false },
    });
    expect(no.truncated).toBe(false);
  });
});

describe("compressToolOutput — anti-regression guard", () => {
  test("tiny output + tiny budget returns raw with degraded no_gain", async () => {
    const raw = "aaaa\nbbbb\ncccc";
    const res = await compressToolOutput({ tool: "bash", output: raw, budgetTokens: 1 });
    expect(res.compressed).toBe(false);
    expect(res.output).toBe(raw);
    expect(res.degraded).toEqual({ reason: "no_gain" });
    expect(res.outTokensEst).toBe(res.rawTokensEst);
  });
});

describe("compressToolOutput — sanitize/redact before hash", () => {
  const redactor = (text: string): string => text.replace(/secret-token-\S+/g, "***");

  test("rawHash hashes the redacted text; rawForStore carries it; hint matches", async () => {
    const dirty = Array.from(
      { length: 60 },
      (_, i) => `row ${i} carrying secret-token-abc and secret-token-${i} inside`,
    ).join("\n");
    const res = await compressToolOutput({
      tool: "bash",
      output: dirty,
      budgetTokens: 128,
      redactor,
    });

    const expectedRaw = redactor(dirty);
    expect(res.rawForStore).toBe(expectedRaw);
    expect(res.rawHash).toBe(`sha256:${await sha256Hex(expectedRaw)}`);
    // The wire result never contains the secret...
    expect(res.output).not.toContain("secret-token");
    expect(res.rawForStore).not.toContain("secret-token");
    // ...and the hint echoes the same hash reference.
    expect(res.output).toContain(`rawHash=${res.rawHash}`);
    expect(res.compressed).toBe(true);
  });

  test("ANSI noise is sanitized before everything else (stable hash)", async () => {
    const clean = "plain text output\nwith two lines only";
    // CR overwrite keeps the last non-empty segment; BS erases one space.
    const noisy =
      "\x1b[31mgarbage\x1b[0m\rplain text output\r\nwith two  \x08lines only\x1b[K";
    const a = await compressToolOutput({ tool: "bash", output: clean });
    const b = await compressToolOutput({ tool: "bash", output: noisy });
    expect(b.rawForStore).toBe(a.rawForStore);
    expect(b.rawHash).toBe(a.rawHash);
    expect(b.output).not.toContain("\x1b");
  });

  test("classifyOverride forces a strategy (string and object forms)", async () => {
    const big = await compressToolOutput({
      tool: "bash",
      output: READ_OUT,
      classifyOverride: "diff",
    });
    expect(big.strategy).toBe("diff");
    expect(big.notes).toContain("classifyOverride");

    const obj = await compressToolOutput({
      tool: "bash",
      output: READ_OUT,
      classifyOverride: { strategy: "grep", confidence: 0.9, signals: ["forced"] },
    });
    expect(obj.strategy).toBe("grep");
    expect(obj.notes.some((n) => n === "forced")).toBe(true);
  });

  test("result satisfies the contracts CompressResult shape", async () => {
    const res = await compressToolOutput({
      tool: "read",
      output: READ_OUT,
      title: "ignored by core",
    });
    // Structural check against every schema field.
    const keys = Object.keys(res).sort();
    expect(keys).toEqual(
      [
        "compressed",
        "degraded",
        "notes",
        "outTokensEst",
        "output",
        "rawForStore",
        "rawHash",
        "rawTokensEst",
        "strategy",
        "truncated",
      ].sort(),
    );
    expect(res.rawHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const asResult: CompressResult = res; // type-level compatibility
    expect(asResult.compressed).toBe(true);
    expect(estimateTokens(res.output)).toBe(res.outTokensEst);
  });
});

describe("createPipelineStats", () => {
  test("counts requests, compressed/passthrough and degraded reasons", () => {
    const stats = createPipelineStats();

    const fake = (
      compressed: boolean,
      degraded: CompressResult["degraded"],
    ): CompressResult => ({
      output: "x",
      rawHash: `sha256:${"0".repeat(64)}`,
      strategy: "unknown",
      compressed,
      truncated: false,
      rawTokensEst: 10,
      outTokensEst: compressed ? 5 : 10,
      degraded,
    });

    stats.record(fake(true, null));
    stats.record(fake(true, null));
    stats.record(fake(false, null));
    stats.record(fake(false, { reason: "no_gain" }));
    stats.record(fake(false, { reason: "timeout" }));

    const snap = stats.snapshot();
    expect(snap.requests).toBe(5);
    expect(snap.compressedCount).toBe(2);
    expect(snap.passthroughCount).toBe(3);
    expect(snap.degradedCounts.no_gain).toBe(1);
    expect(snap.degradedCounts.timeout).toBe(1);
    expect(snap.degradedCounts.crash).toBe(0);

    // Snapshot is a copy: later mutations don't leak in.
    stats.record(fake(true, null));
    expect(stats.snapshot().requests).toBe(6);
    expect(snap.requests).toBe(5);
  });

  test("integrates with real compress results", async () => {
    const stats = createPipelineStats();
    stats.record(await compressToolOutput({ tool: "bash", output: NOISE }));
    stats.record(await compressToolOutput({ tool: "bash", output: "aaaa\nbbbb", budgetTokens: 1 }));
    const snap = stats.snapshot();
    expect(snap.requests).toBe(2);
    expect(snap.passthroughCount).toBe(2);
  });
});
