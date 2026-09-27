import { test, expect } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareBusinessTask, checkBusinessTask, checkReferenceAndMutants } from "../src/business-acceptance"

test("Each order task starts from a standalone snapshot without hidden answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "business-snapshot-"))
  try {
    for (const id of ["T1", "T2", "T3"] as const) {
      const work = join(root, id)
      await prepareBusinessTask(id, work)
      const manifest = JSON.parse(await readFile(join(work, "package.json"), "utf8"))
      expect(manifest.scripts.start).toBe("bun src/server.ts")
      expect((await readFile(join(work, "TASK.md"), "utf8")).length).toBeGreaterThan(100)
      expect((await readFile(join(work, "src/operations.ts"), "utf8")).toLowerCase()).not.toContain("reference")
      const result = await checkBusinessTask(id, work)
      expect(result.passed).toBe(false)
      expect(result.checks.some(check => !check.passed)).toBe(true)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("Trusted HTTP acceptance passes references and rejects every named mutant", async () => {
  const result = await checkReferenceAndMutants()
  for (const task of result) {
    expect(task.reference.passed).toBe(true)
    expect(task.mutants.length).toBeGreaterThan(0)
    for (const mutant of task.mutants) expect(mutant.result.passed).toBe(false)
  }
})
