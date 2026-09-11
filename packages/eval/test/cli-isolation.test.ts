import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BASELINE_PATH } from "../src/check-baseline"
import { REPORT_PATH } from "../src/report"

test("a real CLI child writes only injected report and baseline destinations", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "eval-cli-isolation-"))
  const baseline = readFileSync(BASELINE_PATH, "utf8")
  const report = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, "utf8") : null
  const isolatedBaseline = path.join(tempDir, "baseline.json"),
    isolatedReport = path.join(tempDir, "report.json")
  writeFileSync(isolatedBaseline, baseline)
  try {
    const child = Bun.spawnSync(
      ["bun", path.resolve(import.meta.dir, "../src/cli.ts"), "--quick", "--headroom-strategy", "layered"],
      {
        env: {
          ...process.env,
          EVAL_BASELINE_PATH: isolatedBaseline,
          EVAL_REPORT_PATH: isolatedReport,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    expect(child.exitCode).toBe(0)
    const output = JSON.parse(readFileSync(isolatedReport, "utf8"))
    expect(output.meta.semanticsVersion).toBe(2)
    expect(output.meta.headroomStrategy).toBe("layered")
    for (const group of ["C", "D"]) {
      const rows = output.perFixture.filter((row: any) => row.group === group)
      expect(rows.every((row: any) => row.replay.headroom.strategy === "layered")).toBe(true)
      expect(rows.some((row: any) => row.replay.headroom.activeViewStrategy === "layered" && row.replay.runtime.applied > 0)).toBe(true)
      expect(rows.every((row: any) => row.replay.headroom.memoryMaxTokens === 4096 && row.replay.headroom.summarizerEnabled === false)).toBe(true)
    }
    expect(readFileSync(isolatedBaseline, "utf8")).toBe(baseline)
    expect(readFileSync(BASELINE_PATH, "utf8")).toBe(baseline)
    expect(existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, "utf8") : null).toBe(report)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}, 30_000)
