import { test, expect } from "bun:test"
import { cleanupBusinessRun, runBusinessEvaluation, consumedHeadroom, classifyBusinessFailure } from "../src/business-runner"
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
    await writeFile(join(run, "trace.jsonl"), "trace\n")
    await writeFile(join(run, "artifacts/bluecode/evidence"), "archive\n")
    await writeFile(join(run, "artifacts/home/.npm"), "cache\n")
    await writeFile(join(run, "artifacts/config/cache"), "cache\n")
    await cleanupBusinessRun(root, "T1-natural-baseline-0")
    expect(await readFile(join(run, "trace.jsonl"), "utf8")).toBe("trace\n")
    expect(await readFile(join(run, "artifacts/bluecode/evidence"), "utf8")).toBe("archive\n")
    await expect(readFile(join(run, "work/TASK.md"), "utf8")).rejects.toThrow()
    await expect(readFile(join(run, "artifacts/home/.npm"), "utf8")).rejects.toThrow()
    await expect(readFile(join(run, "artifacts/config/cache"), "utf8")).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("A repeated output directory cannot overwrite a previous result", async () => {
  const root = await mkdtemp(join(tmpdir(), "business-repeat-"))
  const old = join(root, "runs", "T1-natural-baseline-0", "result.json")
  try {
    await mkdir(join(root, "runs", "T1-natural-baseline-0"), { recursive: true })
    await writeFile(old, "original result\n")
    await expect(runBusinessEvaluation({ mode: "offline", image: "missing-image", outputDir: root, runs: [] })).rejects.toThrow("already contains runs")
    expect(await readFile(old, "utf8")).toBe("original result\n")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("Headroom consumption requires a later request carrying a node from the applied view", () => {
  const trace = [
    { type: "runtime", stage: "transform", reason: "view", details: { status: "applied" }, sequence: 3 },
    { type: "transform", nodeIds: ["a"], sequence: 4 },
  ]
  expect(consumedHeadroom(trace, [{ sequence: 2, headroomNodeIds: ["a"] }])).toBe(false)
  expect(consumedHeadroom(trace, [{ sequence: 5, headroomNodeIds: ["b"] }])).toBe(false)
  expect(consumedHeadroom(trace, [{ sequence: 5, headroomNodeIds: ["a"] }])).toBe(true)
  expect(consumedHeadroom([trace[0], { type: "transform", nodeIds: [], sequence: 4 },
    { type: "transform", nodeIds: ["a"], sequence: 5 }], [{ sequence: 6, headroomNodeIds: ["a"] }])).toBe(false)
})

test("Provider rejection and incomplete harness cannot count as delivered business work", () => {
  expect(classifyBusinessFailure({ timedOut: false, aborted: false, budgetExhausted: false, modelStatuses: [429],
    pluginLoaded: true, exitCode: 0, outputTruncated: false, serviceStarted: true, acceptancePassed: false })).toBe("model_or_proxy_error")
  expect(classifyBusinessFailure({ timedOut: true, aborted: false, budgetExhausted: false, modelStatuses: [200],
    pluginLoaded: true, exitCode: -1, outputTruncated: false, serviceStarted: true, acceptancePassed: true })).toBe("timeout")
  expect(classifyBusinessFailure({ timedOut: false, aborted: false, budgetExhausted: false, modelStatuses: [200],
    pluginLoaded: true, exitCode: 0, outputTruncated: true, serviceStarted: true, acceptancePassed: true })).toBe("environment_error")
})
