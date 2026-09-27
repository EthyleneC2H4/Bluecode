import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { cleanupBusinessRun, runBusinessEvaluation } from "./business-runner"
import { plannedBusinessRuns, summarizeBusinessRuns } from "./business-experiment"
import { checkReferenceAndMutants } from "./business-acceptance"

const [action = "plan", ...args] = process.argv.slice(2)
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const required = (name: string) => { const value = option(name); if (!value) throw Error(`Required option ${name}`); return value }
const image = option("--image") ?? "bluecode-business:offline"
const select = () => {
  const id = option("--single")
  if (!id) return undefined
  const run = plannedBusinessRuns().find(run => run.id === id)
  if (!run) throw Error(`Unknown frozen run: ${id}`)
  return [run]
}

if (action === "plan") console.log(JSON.stringify(plannedBusinessRuns(), null, 2))
else if (action === "validate") {
  const output = resolve(required("--output"))
  const result = await checkReferenceAndMutants()
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ schema: 1, checker: "external-http", result }, null, 2) + "\n")
  const valid = result.every(task => task.reference.passed && task.mutants.every(mutant => !mutant.result.passed))
  console.log(JSON.stringify({ output, valid, tasks: result.length, mutants: result.reduce((sum, task) => sum + task.mutants.length, 0) }))
  if (!valid) process.exitCode = 1
}
else if (action === "pending") {
  const output = resolve(required("--output"))
  await mkdir(dirname(output), { recursive: true })
  const pending = { schema: 1, experiment: "order-after-sales", model: "opencode/mimo-v2.5-free", reason: "missing_zen_free_model_credential",
    createdAt: new Date().toISOString(), planned: plannedBusinessRuns().map(run => ({ ...run, status: "not_run" })) }
  await writeFile(output, JSON.stringify(pending, null, 2) + "\n")
  console.log(JSON.stringify({ output, pending: pending.planned.length }))
} else if (action === "offline" || action === "run") {
  const selected = select()
  const result = await runBusinessEvaluation({ mode: action === "offline" ? "offline" : "online", image, outputDir: required("--output"),
    ...(action === "run" ? { apiKeyEnv: option("--api-key-env") ?? "BLUECODE_ZEN_API_KEY", freeModelCheckedAt: required("--free-checked-at") } : {}),
    ...(selected ? { runs: selected } : {}) })
  console.log(JSON.stringify({ output: resolve(required("--output")), records: result.records.map(record => ({ id: record.id, harnessPassed: record.harnessPassed, passed: record.passed, failureType: record.failureType })), summary: result.summary }))
  if (action === "offline" && result.records.some(record => record.harnessPassed !== true)) process.exitCode = 2
} else if (action === "summary") {
  const root = resolve(required("--output"))
  const ledger = JSON.parse(await readFile(`${root}/ledger.json`, "utf8"))
  console.log(JSON.stringify(summarizeBusinessRuns(ledger.records), null, 2))
} else if (action === "cleanup") {
  await cleanupBusinessRun(required("--output"), required("--single"))
  console.log(JSON.stringify({ cleaned: required("--single"), retained: ["manifest.json", "result.json", "acceptance.json", "request-usage.json", "patch.diff", "events.jsonl"] }))
} else throw Error(`Unknown business command: ${action}`)
