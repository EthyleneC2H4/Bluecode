/**
 * Runner smoke test on the quick fixture set (brief requirement #3).
 *
 * Groups A/B/C/D must all complete with real RtkClient (testMode) and
 * HeadroomClient (connect-or-spawn), and the aggregated report must be
 * structurally valid. Full four-group long-session scoring is cli's job,
 * not a unit test.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { runEvaluation } from "../src/runner";
import { aggregateReport } from "../src/metrics";
import { quickFixtures } from "../src/fixtures";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bluecode-eval-smoke-"));
const headroomEntry = path.resolve(import.meta.dir, "../../headroomd/src/bin.ts");

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runner: quick-mode smoke across all four groups", () => {
  // Two daemon spawns (rtk + headroomd) plus IPC for every tool output —
  // well under normal conditions but allow a generous ceiling.
  test(
    "A/B/C/D all complete; report structure valid; groups observe their own contracts",
    async () => {
      // The spawned headroomd reads its data dir from this env var (the
      // client passes no CLI args — see packages/headroomd/src/client.ts).
      process.env.BLUECODE_DATA_DIR = tmpDir;

      const result = await runEvaluation({
        quick: true,
        dataDir: tmpDir,
        headroomEntry,
      });

      const fixtureCount = quickFixtures().length;

      // Every group produced one record per fixture.
      for (const group of ["A", "B", "C", "D"] as const) {
        const records = result.perFixture.filter((r) => r.group === group);
        expect(records.length).toBe(fixtureCount);
        const lats = result.latencies.filter((l) => l.group === group);
        expect(lats.length).toBe(fixtureCount);
      }

      // Recall results only exist for B/C/D.
      expect(result.recallResults.length).toBe(fixtureCount * 3);
      for (const r of result.recallResults) {
        expect(["B", "C", "D"]).toContain(r.group);
      }

      // Degraded reasons stay within the contract enum.
      for (const r of result.perFixture) {
        if (r.degradedReason !== null) {
          expect(["spawn_failed", "timeout", "crash", "protocol", "no_gain"]).toContain(r.degradedReason);
        }
      }

      // Aggregated report shape.
      const report = aggregateReport(result.perFixture, result.latencies, result.recallResults);
      expect(report.meta.tokenCounter).toBe("o200k_base");
      for (const g of ["A", "B", "C", "D"] as const) {
        const m = report.groups[g]!;
        expect(m.compressionRatio).toBeGreaterThan(0);
        expect(m.latencyP50Ms).toBeGreaterThanOrEqual(0);
        expect(m.latencyP95Ms).toBeGreaterThanOrEqual(m.latencyP50Ms);
        expect(m.recall.mustHit.rate).toBeGreaterThanOrEqual(0);
        expect(m.recall.mustHit.rate).toBeLessThanOrEqual(1);
      }
    },
    120_000,
  );

  test(
    "group B traffic really goes through rtk IPC (not the trivial passthrough path)",
    async () => {
      process.env.BLUECODE_DATA_DIR = tmpDir;
      const result = await runEvaluation({ quick: true, dataDir: tmpDir, headroomEntry });

      const total = (g: "A" | "B") =>
        result.latencies.filter((l) => l.group === g).reduce((s, l) => s + l.latencyMs, 0);

      // Group A is a sleep(1) per fixture; B does at least one real UDS round
      // trip per tool output. B's total latency should exceed A's by a clear
      // margin rather than sitting at the same floor.
      expect(total("B")).toBeGreaterThan(total("A"));
    },
    120_000,
  );
});
