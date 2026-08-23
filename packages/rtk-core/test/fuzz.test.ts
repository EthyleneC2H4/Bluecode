/**
 * Seeded fuzz: >=100 samples across five output shapes plus noise, asserting
 * pipeline invariants (no throw, string output, compression actually shrinks,
 * stable rawHash, planted anchor lines survive).
 */
import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@bluecode/shared";
import { compressToolOutput } from "../src/pipeline";

// Deterministic LCG so failures reproduce exactly.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Shape = "ls-la" | "pathlist" | "grep" | "read" | "test" | "noise";

const SHAPES: Shape[] = ["ls-la", "pathlist", "grep", "read", "test", "noise"];

const pick = <T>(rand: () => number, arr: readonly T[]): T => {
  const idx = Math.floor(rand() * arr.length);
  const v = arr[idx];
  if (v === undefined) throw new Error("fuzz generator bug: empty array");
  return v;
};
const int = (rand: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rand() * (hi - lo + 1));

/** Generate one sample of the given shape; returns text plus anchor-planted markers. */
function generate(
  shape: Shape,
  rand: () => number,
): { text: string; markers: string[]; tool: string } {
  const markers: string[] = [];
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const word = () => pick(rand, words);
  const line = (n: number) => `${word()} ${word()} ${n} ${word()}${word()}`;

  switch (shape) {
    case "ls-la": {
      const dirMarker = `drwxr-xr-x@ 3 u g 96 Jan  1 00:00 zzz_anchor_dir_${int(rand, 10, 99)}`;
      markers.push("total " + int(rand, 10, 99), dirMarker);
      const rows = [markers[1], markers[0]];
      for (let i = 0; i < int(rand, 12, 30); i++) {
        rows.push(`-rw-r--r--@ 1 u g ${i * 7} Jan  1 00:${String(i % 60).padStart(2, "0")} file-${i}.txt`);
      }
      return { text: rows.join("\n"), markers, tool: pick(rand, ["bash", "ls", "unknown-tool"]) };
    }
    case "pathlist": {
      const marker = `zzz_anchor_pkg/mod-${int(rand, 10, 99)}/kept.ts`;
      markers.push(marker);
      const rows: string[] = [];
      for (let i = 0; i < int(rand, 15, 40); i++) {
        rows.push(`pkg${i % 4}/sub/dir-${i}/file_${i}.ts`);
      }
      rows.splice(int(rand, 0, 4), 0, marker); // within first 5 of its group
      return { text: rows.join("\n"), markers, tool: pick(rand, ["bash", "glob"]) };
    }
    case "grep": {
      const errMarker = `zzz/anchor_${int(rand, 10, 99)}.rs:777:ERROR catastrophic failure ${int(rand, 10, 99)}`;
      markers.push(errMarker);
      const rows: string[] = [];
      const files = ["src/a.ts", "src/b.ts", "lib/c.py"];
      for (let i = 0; i < int(rand, 12, 35); i++) {
        const f = files[i % files.length];
        rows.push(`${f}:${i * 2 + 1}:match on ${word()} ${word()}`);
      }
      rows.splice(int(rand, 0, 6), 0, errMarker);
      return { text: rows.join("\n"), markers, tool: pick(rand, ["bash", "grep"]) };
    }
    case "read": {
      const topMarker = `ANCHOR_TOP_${int(rand, 100, 999)} unique`;
      const bottomMarker = `ANCHOR_BOTTOM_${int(rand, 100, 999)} unique`;
      markers.push(topMarker, bottomMarker);
      const total = int(rand, 45, 120);
      const rows: string[] = [];
      for (let n = 1; n <= total; n++) {
        const content =
          n === 2 ? topMarker : n === total - 3 ? bottomMarker : `body ${line(n)}`;
        rows.push(`${String(n).padStart(5)}\t${content}`);
      }
      return { text: rows.join("\n"), markers, tool: pick(rand, ["bash", "read"]) };
    }
    case "test": {
      const failMarker = `--- FAIL: TestZebra_${int(rand, 10, 99)} (0.00s)`;
      const summaryMarker = `Tests: ${int(rand, 11, 99)} passed, 1 failed, 100 total`;
      markers.push(failMarker, summaryMarker);
      const rows = [
        "PASS suite_a.test.js",
        ...Array.from({ length: int(rand, 8, 25) }, (_, i) => `    ✓ generated case ${i}`),
        failMarker,
        "    at Object.<anonymous> (suite_a.test.js:9:11)",
        "    Expected: 4",
        "    Received: 5",
        "",
        `FAIL suite_b.test.js`,
        summaryMarker,
        "Time: 1.23 s",
      ];
      return { text: rows.join("\n"), markers, tool: pick(rand, ["bash", "test-runner"]) };
    }
    case "noise": {
      const rows = Array.from({ length: int(rand, 3, 30) }, () => line(int(rand, 0, 999)));
      return { text: rows.join("\n"), markers, tool: pick(rand, ["bash", "mystery"]) };
    }
  }
}

describe("seeded fuzz — 120 samples", () => {
  test("invariants hold across shapes, budgets and pollution", async () => {
    const rand = lcg(20260822);
    let compressedCount = 0;
    let passthroughCount = 0;

    for (let i = 0; i < 120; i++) {
      const shape = pick(rand, SHAPES);
      const { text, markers, tool } = generate(shape, rand);

      // Occasionally pollute with ANSI / CR / backspaces.
      const polluted =
        rand() < 0.3
          ? `\x1b[${int(rand, 30, 37)}m${text.replace(/\n/, "\r\x1b[2K\n")}\x1b[0m`
          : text;

      const budget = pick(rand, [64, 128, 512, 2048] as const);
      const truncated = rand() < 0.3;

      const res = await compressToolOutput({
        tool,
        output: polluted,
        budgetTokens: budget,
        metadata: truncated ? { truncated: true } : undefined,
      });

      // 1. Output is a plain string, no escape sequences survive sanitization.
      expect(typeof res.output).toBe("string");
      expect(res.output).not.toContain("\x1b");

      // 2. Compression flag consistency.
      if (res.compressed) {
        compressedCount++;
        expect(res.outTokensEst).toBeLessThan(res.rawTokensEst);
      } else {
        passthroughCount++;
      }

      // 3. Token accounting is honest.
      const { estimateTokens } = await import("@bluecode/shared");
      expect(res.outTokensEst).toBe(estimateTokens(res.output));
      expect(res.truncated).toBe(truncated);

      // 4. rawHash is stable and matches rawForStore exactly.
      expect(res.rawHash).toBe(`sha256:${await sha256Hex(res.rawForStore)}`);
      if (res.compressed) expect(res.output).toContain(`rawHash=${res.rawHash}`);

      // 5. Degraded is only ever null or no_gain in core.
      expect(res.degraded === null || res.degraded?.reason === "no_gain").toBe(true);

      // 6. Planted anchors always survive; strategy-guaranteed by design.
      for (const marker of markers) {
        if (shape === "noise") continue; // fallback lines are legitimately trimmable
        expect(res.output).toContain(marker);
      }
      if (shape === "noise" && !res.compressed) {
        expect(res.output).toBe(res.rawForStore);
      }
    }

    // The mix must exercise both paths meaningfully.
    expect(compressedCount).toBeGreaterThan(20);
    expect(passthroughCount).toBeGreaterThan(5);
  });
});
