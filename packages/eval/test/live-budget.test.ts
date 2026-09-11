import { expect, test } from "bun:test"
import { runLiveEvaluation } from "../src/live-runner"
const options={model:"opencode/mimo-v2.5-free",apiKeyEnv:"BLUECODE_NO_LIVE_TEST_KEY",maxRequests:1,maxInputTokens:100,maxOutputTokens:100,output:"unused.json"}
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
