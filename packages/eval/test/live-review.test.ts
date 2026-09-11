import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { liveTasks } from "../src/live-tasks"
import { validateTask, verifierFor } from "../src/live-validation"
import { inputReservation, providerObservation, mainUsage } from "../src/live-observation"
import { command } from "../src/live-process"

test("verifier deletion cannot pass any test-repair task", async () => {
  for (const task of liveTasks().filter(t => t.category === "test-repair")) {
    const dir = await mkdtemp(join(tmpdir(), "live-review-"))
    try {
      await mkdir(join(dir, "src"))
      const manifest = '{"type":"module"}'
      await writeFile(join(dir, "package.json"), manifest)
      for (const [path, text] of Object.entries(task.files)) await writeFile(join(dir, path), text)
      await writeFile(join(dir, "test.mjs"), "")
      expect((await validateTask(dir, task, manifest, task.files["test.mjs"]!)).passed).toBe(false)
      await writeFile(join(dir, "test.mjs"), verifierFor(task))
      expect((await validateTask(dir, task, manifest, task.files["test.mjs"]!)).passed).toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})
test("non-repair tasks preserve verifier bytes even when acceptance passes", async () => {
  const task = liveTasks().find(t => t.id === "clamp")!
  const dir = await mkdtemp(join(tmpdir(), "live-review-"))
  try {
    await mkdir(join(dir, "src")); await writeFile(join(dir, "package.json"), '{"type":"module"}')
    await writeFile(join(dir, "src/main.js"), "export const clamp=(n,min,max)=>Math.max(min,Math.min(max,n))")
    await writeFile(join(dir, "test.mjs"), "")
    expect((await validateTask(dir, task, '{"type":"module"}', verifierFor(task))).passed).toBe(false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test("summary response reports actual nullable usage and bounded error code", () => {
  expect(providerObservation('{"usage":{"prompt_tokens":345,"completion_tokens":21}}')).toEqual({ input: 345, output: 21, errorCode: null })
  expect(providerObservation('{"error":{"code":"MissingSessionID","message":"secret source"}}').errorCode).toBe("MissingSessionID")
  expect(providerObservation('{"error":{"code":"sk-secret-or-message /bad","message":"secret source"}}').errorCode).toBeNull()
})
test("missing main step token fields remain unknown", () => {
  expect(mainUsage([{ type: "step_finish", part: { tokens: { input: 3 } } }]).complete).toBe(false)
})
test("input reservation bounds token-dense UTF8 and includes framing", () => {
  const body = { messages: [{ role: "user", content: "你好🙂".repeat(100) }] }
  expect(inputReservation(body)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(body)))
})
test("command deadline cleans descendants holding inherited pipes", async () => {
  const start = performance.now()
  const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'inherit'});setTimeout(()=>{},2000)`
  const result = await command([process.execPath, "-e", script], process.cwd(), {}, 100)
  expect(result.timedOut).toBe(true)
  expect(performance.now() - start).toBeLessThan(1000)
})

test("candidate states distinguish HTTP success, readiness, rejection and actual replay", async () => {
  const { candidateObservation } = await import("../src/live-candidates")
  const base = { operations: [{ nodeId: "old" }] }, candidate = { operations: [{ nodeId: "new" }] }
  expect(candidateObservation({ status: "queued", base, candidate: null }, []).status).toBe("queued")
  expect(candidateObservation({ status: "ready", base, candidate }, []).status).toBe("ready")
  expect(candidateObservation({ status: "ready", base, candidate }, ["new"]).status).toBe("applied")
  expect(candidateObservation({ status: "rejected", reason: "Summary did not improve the bounded rule view", base, candidate: null }, []).reasonCode).toBe("not-improved")
})

test("actual usage above a reservation stops subsequent requests without hiding missing usage", async () => {
  const { createLiveBudget } = await import("../src/live-observation")
  const budget = createLiveBudget({ maxRequests: 4, maxInputTokens: 100000, maxOutputTokens: 1000 })
  const first = budget.reserve({ messages: [] }, 100)!
  expect(budget.snapshot().usageComplete).toBe(false)
  budget.settle(first, { input: first.inputReservation + 10, output: 1 })
  expect(budget.snapshot().violation).toBe(true)
  expect(budget.snapshot().debitedInput).toBe(first.inputReservation + 10)
  expect(budget.reserve({}, 100)).toBeNull()
})
test("SSE usage and summary errors stay separated from absent fields", () => {
  expect(providerObservation('data: {"usage":{"prompt_tokens":80,"completion_tokens":5}}\n\ndata: [DONE]\n')).toEqual({ input: 80, output: 5, errorCode: null })
  expect(providerObservation('{"choices":[]}')).toEqual({ input: null, output: null, errorCode: null })
  expect(mainUsage([{ type: "step_finish", part: { tokens: { input: 3, output: 0, cache: { read: 0, write: 0 } }, cost: 0 } }])).toEqual({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, complete: true })
})
test("evidence probes accept a complete original sentence while preserving strict format failure", async () => {
  const { probesFor, evidencePresent } = await import("../src/live-observation")
  const task = liveTasks()[0]!
  const probes = probesFor({ fact: task.fact + ". Do not add dependencies.", reason: task.reason }, task)
  expect(probes.strictExact.fact).toBe(false)
  expect(probes.evidencePresent.fact).toBe(true)
  expect(evidencePresent("It is not true that " + task.fact + ".", task.fact)).toBe(false)
  expect(evidencePresent(task.fact + ". This is false.", task.fact)).toBe(false)
  expect(evidencePresent("Prefix " + task.fact + " suffix", task.fact)).toBe(false)
  const log = liveTasks().find(task => task.id === "log-auth")!
  expect(evidencePresent(log.reason, log.reason)).toBe(true)
})
test("normal leader exit cleans pipe-holding descendants and scope abort is bounded", async () => {
  const { createCommandScope } = await import("../src/live-process")
  const start = performance.now()
  const script = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'inherit'});console.log(p.pid);process.exit(0)`
  const result = await command([process.execPath, "-e", script], process.cwd(), {}, 500)
  expect(result.code).toBe(0)
  expect(result.timedOut).toBe(false)
  expect(performance.now() - start).toBeLessThan(1000)
  const { spawnSync } = await import("node:child_process")
  const descendant = Number(result.stdout.trim())
  expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true)
  const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(descendant)], { encoding: "utf8" }).stdout.trim()
  expect(state === "" || state.startsWith("Z")).toBe(true)
  const scope = createCommandScope()
  const pending = scope.command([process.execPath, "-e", "setTimeout(()=>{},2000)"], process.cwd(), {}, 3000)
  await scope.close()
  expect((await pending).aborted).toBe(true)
})

test("candidate database observation is read-only and never emits source plans", async () => {
  const { Database } = await import("bun:sqlite")
  const { readCandidates } = await import("../src/live-candidates")
  const dir = await mkdtemp(join(tmpdir(), "live-candidate-read-"))
  try {
    const path = join(dir, "meta.db"), db = new Database(path)
    db.exec("CREATE TABLE enhancement_jobs(job_id TEXT,session_id TEXT,status TEXT,reason TEXT,base_plan TEXT,candidate TEXT)")
    db.query("INSERT INTO enhancement_jobs VALUES(?,?,?,?,?,?)").run("job", "session", "ready", null, JSON.stringify({ operations: [{ nodeId: "old" }], summary: "DO_NOT_EXPORT_SOURCE" }), JSON.stringify({ operations: [{ nodeId: "new" }] }))
    db.close()
    const result = readCandidates(path, "session", ["new"])
    expect(result.jobs[0]?.status).toBe("applied")
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPORT_SOURCE")
    expect(readCandidates(path, "other", []).jobs).toEqual([])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("provider top-level safe error names survive without emitting error payloads", () => {
  expect(providerObservation('{"name":"MissingSessionID","data":{"secret":"hidden"}}')).toEqual({ input: null, output: null, errorCode: "MissingSessionID" })
})
