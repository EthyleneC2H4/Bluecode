import { test, expect } from "bun:test"
import { cleanupBusinessRun, runBusinessEvaluation } from "../src/business-runner"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("Online business evaluation refuses absent free-model credentials before starting Docker", async () => {
  const name = "BLUECODE_BUSINESS_MISSING_KEY_FOR_TEST"
  delete process.env[name]
  await expect(runBusinessEvaluation({ mode: "online", image: "missing-image", outputDir: "/tmp/unused-business-test", apiKeyEnv: name, runs: [] })).rejects.toThrow("Missing free-model credential")
})

test("Cleanup removes disposable code and caches while retaining review evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "business-cleanup-"))
  const run = join(root, "runs", "T1-natural-baseline-0")
  try {
    for (const directory of ["work", "source", "artifacts/home", "artifacts/config", "artifacts/bluecode"]) await mkdir(join(run, directory), { recursive: true })
    await writeFile(join(run, "result.json"), "{}")
    await writeFile(join(run, "artifacts/trace.jsonl"), "trace\n")
    await writeFile(join(run, "artifacts/bluecode/evidence"), "archive\n")
    await writeFile(join(run, "artifacts/home/.npm"), "cache\n")
    await writeFile(join(run, "artifacts/config/cache"), "cache\n")
    await cleanupBusinessRun(root, "T1-natural-baseline-0")
    expect(await readFile(join(run, "artifacts/trace.jsonl"), "utf8")).toBe("trace\n")
    expect(await readFile(join(run, "artifacts/bluecode/evidence"), "utf8")).toBe("archive\n")
    await expect(readFile(join(run, "work/TASK.md"), "utf8")).rejects.toThrow()
    await expect(readFile(join(run, "artifacts/home/.npm"), "utf8")).rejects.toThrow()
    await expect(readFile(join(run, "artifacts/config/cache"), "utf8")).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
