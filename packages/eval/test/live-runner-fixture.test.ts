import { expect, test } from "bun:test"
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runLiveEvaluation } from "../src/live-runner"

test("offline runner fixture saves separate main/summary actual usage and verified outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-runner-fixture-")), originalFetch = globalThis.fetch, originalPath = process.env.PATH
  const keyEnv = "BLUECODE_LOCAL_RUNNER_FIXTURE_KEY"
  let forwarded = 0
  try {
    await writeFile(join(dir, "opencode"), `#!/usr/bin/env bun
import {writeFile} from 'node:fs/promises';
const args=process.argv.slice(2);
if(args[0]==='--version') console.log('offline fixture (not OpenCode or LLM)');
else if(args[0]==='import') console.log('Imported session: fixture');
else {
  const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  const base=config.provider.opencode.options.baseURL;
  for(const url of [base.replace('/main','/summary'),base]) await fetch(url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'mimo-v2.5-free',max_tokens:20,messages:[{role:'user',content:'fixture'}]})});
  await writeFile('src/main.js','export const clamp=(n,min,max)=>Math.max(min,Math.min(max,n))\\n');
  console.log(JSON.stringify({type:'step_finish',part:{tokens:{input:10,output:2,cache:{read:3,write:0}},cost:0}}));
}
`)
    await chmod(join(dir, "opencode"), 0o700)
    process.env.PATH = `${dir}:${originalPath}`
    process.env[keyEnv] = "local-fixture-placeholder"
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input) === "https://opencode.ai/zen/v1/chat/completions") {
        forwarded++
        return Response.json({ usage: { prompt_tokens: 13, completion_tokens: 2 }, choices: [] })
      }
      return originalFetch(input, init)
    }) as typeof fetch
    const output = join(dir, "report.json")
    const result = await runLiveEvaluation({ model: "opencode/mimo-v2.5-free", apiKeyEnv: keyEnv, maxRequests: 4, maxInputTokens: 50000, maxOutputTokens: 1000, output, tasks: ["clamp"], arms: ["enhanced"], repeats: 1, concurrency: 1 })
    expect(forwarded).toBe(2)
    expect(result.version).toBe(2)
    const record = result.records[0]!
    expect(record.passed).toBe(true)
    expect(record.summaryUsage).toEqual({ input: 13, output: 2, requests: 1, complete: true })
    expect(record.totalUsage).toEqual({ input: 26, output: 4, complete: true })
    expect(record.candidates.complete).toBe(false)
    expect(record.incomplete).toBe(true)
    expect(result.budgets.actualInput).toBe(26)
    expect(await readFile(output, "utf8")).not.toContain("local-fixture-placeholder")
  } finally {
    globalThis.fetch = originalFetch
    process.env.PATH = originalPath
    delete process.env[keyEnv]
    await rm(dir, { recursive: true, force: true })
  }
})
