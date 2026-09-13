import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as processes from "../src/live-process"
import { runLiveEvaluation } from "../src/live-runner"
const options={model:"opencode/mimo-v2.5-free",apiKeyEnv:"BLUECODE_NO_LIVE_TEST_KEY",maxRequests:1,maxInputTokens:100,maxOutputTokens:100,output:"unused.json"}

test("historical live comparisons pass four retained turns to every host arm without model requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-retention-config-"))
  const envName = "BLUECODE_RETENTION_CONFIG_TEST_KEY", previous = process.env[envName]
  process.env[envName] = "local-test-placeholder"
  const configs: any[] = [], controller = new AbortController()
  const scope = spyOn(processes, "createCommandScope").mockReturnValue({
    signal: controller.signal, abort: () => controller.abort(), close: async () => {},
    command: async (argv, _cwd, env) => {
      if (argv[0] === "opencode" && argv[1] === "run") configs.push(JSON.parse(env.OPENCODE_CONFIG_CONTENT!))
      const importing = argv[0] === "opencode" && argv[1] === "import"
      return { code: importing || argv[1] === "--version" ? 0 : 1, stdout: importing ? "Imported session: fixture" : "",
        stderr: "", timedOut: false, aborted: false, outputTruncated: false }
    },
  })
  try {
    const report = await runLiveEvaluation({ ...options, apiKeyEnv: envName, output: join(dir, "report.json"), tasks: ["clamp"], repeats: 1, concurrency: 1 })
    expect(configs).toHaveLength(3)
    expect(configs.map(config => config.plugin[0][1].headroom.retainRecentTurns)).toEqual([4, 4, 4])
    expect(report.retainRecentTurns).toBe(4)
    expect(report.requests).toHaveLength(0)
  } finally {
    scope.mockRestore()
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous
    await rm(dir, { recursive: true, force: true })
  }
})
test("live evaluation requires explicit free model and positive budgets before any model or host call",async()=>{
  await expect(runLiveEvaluation({...options,model:"opencode/paid-model"})).rejects.toThrow("zero-cost")
  await expect(runLiveEvaluation({...options,maxRequests:0})).rejects.toThrow("Explicit positive")
  await expect(runLiveEvaluation({...options,maxInputTokens:NaN})).rejects.toThrow("Explicit positive")
  await expect(runLiveEvaluation({...options,repeats:0})).rejects.toThrow("Repeat count")
  await expect(runLiveEvaluation({...options,tasks:["missing"]})).rejects.toThrow("Unknown")
  for (const taskTimeoutMs of [0, 999, 3600001, 1.5, NaN]) await expect(runLiveEvaluation({...options,taskTimeoutMs})).rejects.toThrow("Task timeout")
  await expect(runLiveEvaluation(options)).rejects.toThrow("Missing configured")
})

test("live CLI forwards an explicit task timeout before host or credential lookup", async () => {
  const child = Bun.spawn(["bun", new URL("../src/live-cli.ts", import.meta.url).pathname,
    "--model", options.model, "--api-key-env", options.apiKeyEnv, "--max-requests", "1", "--max-input-tokens", "100", "--max-output-tokens", "100", "--output", "unused.json", "--task-timeout-ms", "0"], { stdout: "pipe", stderr: "pipe" })
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).not.toBe(0)
  expect(stderr).toContain("Task timeout")
})
