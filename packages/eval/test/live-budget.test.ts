import { expect, test } from "bun:test"
import { runLiveEvaluation } from "../src/live-runner"
const options={model:"opencode/mimo-v2.5-free",apiKeyEnv:"BLUECODE_NO_LIVE_TEST_KEY",maxRequests:1,maxInputTokens:100,maxOutputTokens:100,output:"unused.json"}
test("live evaluation requires explicit free model and positive budgets before any model or host call",async()=>{
  await expect(runLiveEvaluation({...options,model:"opencode/paid-model"})).rejects.toThrow("zero-cost")
  await expect(runLiveEvaluation({...options,maxRequests:0})).rejects.toThrow("Explicit positive")
  await expect(runLiveEvaluation({...options,maxInputTokens:NaN})).rejects.toThrow("Explicit positive")
  await expect(runLiveEvaluation({...options,repeats:0})).rejects.toThrow("Repeat count")
  await expect(runLiveEvaluation({...options,tasks:["missing"]})).rejects.toThrow("Unknown")
  await expect(runLiveEvaluation(options)).rejects.toThrow("Missing configured")
})
