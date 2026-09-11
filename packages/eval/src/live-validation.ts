import { readFile, writeFile, mkdtemp, cp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LiveTask } from "./live-tasks"
import { command, type Command } from "./live-process"
export const verifierFor = (task: LiveTask) => `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import * as m from './src/main.js'; ${task.checks}\n`
export async function validateTask(workdir: string, task: LiveTask, manifest: string, originalVerifier: string, run: Command = command) {
  const source = await readFile(join(workdir, "src/main.js"))
  const verifier = await readFile(join(workdir, "test.mjs"))
  const manifestUnchanged = (await readFile(join(workdir, "package.json"))).equals(Buffer.from(manifest))
  const sourceUnchanged = source.equals(Buffer.from(task.files["src/main.js"]!))
  const verifierUnchanged = verifier.equals(Buffer.from(originalVerifier))
  const tests = await run(["bun", "test.mjs"], workdir, {}, 10000)
  await writeFile(join(workdir, "acceptance.mjs"), verifierFor(task))
  const acceptance = await run(["bun", "acceptance.mjs"], workdir, {}, 10000)
  const verifierStable = (await readFile(join(workdir, "test.mjs"))).equals(verifier)
  const finalManifestUnchanged = (await readFile(join(workdir, "package.json"))).equals(Buffer.from(manifest))
  const finalSourceUnchanged = (await readFile(join(workdir, "src/main.js"))).equals(Buffer.from(task.files["src/main.js"]!))
  let mutation: { correctPasses: boolean; mutantFails: boolean } | null = null
  if (task.category === "test-repair") {
    const isolated = await mkdtemp(join(tmpdir(), "live-mutation-"))
    try {
      await cp(workdir, isolated, { recursive: true })
      // Run the submitted verifier unchanged against the fixture's correct and
      // corresponding incorrect implementations in a private copied workspace.
      await writeFile(join(isolated, "src/main.js"), task.files["src/main.js"]!)
      const correct = await run(["bun", "test.mjs"], isolated, {}, 10000)
      await writeFile(join(isolated, "src/main.js"), task.mutant ?? task.files["src/main.js"]!)
      const correctTestStable = (await readFile(join(isolated, "test.mjs"))).equals(verifier)
      const mutant = await run(["bun", "test.mjs"], isolated, {}, 10000)
      const mutantTestStable = (await readFile(join(isolated, "test.mjs"))).equals(verifier)
      mutation = { correctPasses: correct.code === 0 && !correct.timedOut && !correct.aborted && correctTestStable, mutantFails: mutant.code > 0 && !mutant.timedOut && !mutant.aborted && mutantTestStable && Boolean(task.mutant) }
    } finally { await rm(isolated, { recursive: true, force: true }) }
  }
  const constraints = manifestUnchanged && finalManifestUnchanged && verifierStable && (task.category === "test-repair" ? sourceUnchanged && finalSourceUnchanged && mutation?.correctPasses === true && mutation.mutantFails : verifierUnchanged)
  return { passed: tests.code === 0 && acceptance.code === 0 && constraints, constraints,
    manifestUnchanged: manifestUnchanged && finalManifestUnchanged, sourceUnchanged: sourceUnchanged && finalSourceUnchanged, verifierUnchanged, verifierStable, mutation, validationError: acceptance.stderr }
}
