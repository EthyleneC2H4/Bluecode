import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { liveTasks, seedSession, type LiveTask } from "./live-tasks"
import { createCommandScope, type Command } from "./live-process"
import { createLiveBudget, mainUsage, nullableSum, probesFor, providerObservation } from "./live-observation"
import { validateTask, verifierFor } from "./live-validation"
import { readCandidates } from "./live-candidates"

export interface LiveOptions {
  model: string; apiKeyEnv: string; maxRequests: number; maxInputTokens: number; maxOutputTokens: number
  output: string; tasks?: string[]; repeats?: number; arms?: Array<"legacy"|"layered"|"enhanced">; concurrency?: number
}
const FREE_MODEL = "opencode/mimo-v2.5-free"
const safe = (text: string, key: string) => text.replaceAll(key,"[redacted]").replace(/sk-[A-Za-z0-9_-]{16,}/g,"[redacted]")

export async function runLiveEvaluation(options: LiveOptions) {
  if (options.model !== FREE_MODEL) throw Error(`This zero-cost runner permits only ${FREE_MODEL}; no paid fallback`)
  for(const value of [options.maxRequests,options.maxInputTokens,options.maxOutputTokens]) if(!Number.isSafeInteger(value)||value<=0) throw Error("Explicit positive request/input/output budgets required")
  if (options.repeats !== undefined && (!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 10)) throw Error("Repeat count must be 1 through 10")
  if (options.concurrency !== undefined && ![1,2,3,4].includes(options.concurrency)) throw Error("Concurrency must be 1 through 4")
  if (options.arms && (!options.arms.length || new Set(options.arms).size !== options.arms.length || options.arms.some(arm=>!["legacy","layered","enhanced"].includes(arm)))) throw Error("Unknown or duplicate evaluation arms")
  if (options.tasks && (!options.tasks.length || new Set(options.tasks).size !== options.tasks.length || options.tasks.some(id=>!liveTasks().some(task=>task.id===id)))) throw Error("Unknown or duplicate evaluation tasks")
  const key=process.env[options.apiKeyEnv]
  if(!key) throw Error("Missing configured API key environment variable")
  const model=options.model.slice("opencode/".length)
  const root=await mkdtemp(join(tmpdir(),"headroom-live-"))
  const records: any[] = [], requests: any[] = []
  const budget = createLiveBudget(options), commands = createCommandScope()
  const activeRequests = new Map<any, { abort: AbortController; done: Promise<void> }>()
  const interrupt = () => commands.abort()
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt)
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, async fetch(request) {
    const match = new URL(request.url).pathname.match(/^\/([a-zA-Z0-9-]+)\/(main|summary)\/chat\/completions$/)
    if (!match || request.method !== "POST") return new Response("Unknown evaluation route", { status: 404 })
    let body: any
    try { body = await request.json() } catch { return new Response("Invalid request", { status: 400 }) }
    if (body.model !== model) return new Response("Model outside free-only allowlist", { status: 403 })
    const requestedOutput = Number(body.max_tokens)
    const output = Number.isSafeInteger(requestedOutput) && requestedOutput > 0 ? Math.min(requestedOutput, 2048) : 2048
    if (requests.filter(r => r.run === match[1] && r.kind === "main").length >= 8) return new Response("This task reached its eight-request limit", { status: 402 })
    body.max_tokens = output
    const reservation = commands.signal.aborted ? null : budget.reserve(body, output)
    if (!reservation) return new Response("Explicit evaluation budget exhausted", { status: 402 })
    const encoded = JSON.stringify(body)
    const record: any = { run: match[1], kind: match[2], headroomMarkers: (encoded.match(/\[headroom node:/g) ?? []).length,
      nodeIds: [...new Set([...encoded.matchAll(/\[headroom node:([0-9a-f]{64})\]/g)].map(match => match[1]))],
      messages: body.messages?.length, ...reservation, hasHostSession: request.headers.has("x-opencode-session"), status: null, durationMs: 0, errorCode: null }
    requests.push(record)
    const abort = new AbortController(), done = Promise.withResolvers<void>()
    activeRequests.set(record, { abort, done: done.promise })
    const headers = new Headers(request.headers)
    headers.delete("host"); headers.delete("content-length"); headers.delete("accept-encoding")
    headers.set("authorization", `Bearer ${key}`)
    const start = performance.now()
    try {
      const response = await fetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST", headers, body: encoded,
        signal: AbortSignal.any([AbortSignal.timeout(90000), commands.signal, abort.signal, request.signal]), redirect: "error" })
      record.status = response.status
      const bytes = await boundedResponse(response)
      const observed = providerObservation(new TextDecoder().decode(bytes))
      budget.settle(reservation, observed)
      Object.assign(record, reservation, { errorCode: observed.errorCode, usageComplete: observed.input !== null && observed.output !== null })
      const outHeaders = new Headers(response.headers)
      outHeaders.delete("content-encoding"); outHeaders.delete("content-length"); outHeaders.delete("transfer-encoding")
      return new Response(bytes, { status: response.status, headers: outHeaders })
    } catch {
      record.status = "transport-error"; record.errorCode = "transport-error"; record.usageComplete = false
      budget.settle(reservation, { input: null, output: null }); Object.assign(record, reservation)
      return new Response("Evaluation upstream unavailable", { status: 502 })
    } finally { record.durationMs = performance.now() - start; activeRequests.delete(record); done.resolve() }
  } })
  const finishRequests = async (id: string) => {
    const pending = [...activeRequests].filter(([record]) => record.run === id).map(([, entry]) => entry)
    if (!pending.length) return
    await Promise.race([Promise.all(pending.map(entry => entry.done)), new Promise(resolve => setTimeout(resolve, 2000))])
    for (const entry of pending) entry.abort.abort()
    await Promise.all(pending.map(entry => entry.done))
  }
  let hostVersion = "unknown"
  const todo = liveTasks().filter(task => !options.tasks || options.tasks.includes(task.id)).flatMap(task =>
    Array.from({ length: options.repeats ?? 2 }, (_, repeat) => (options.arms ?? ["legacy", "layered", "enhanced"]).map(arm => ({ task, repeat, arm }))).flat())
  const report = () => ({ version: 2, baseline: "62589ac", model: options.model, concurrency: options.concurrency ?? 2, hostVersion, monetaryBudget: 0,
    usageMode: "Main OpenCode input excludes cache. Summary usage is separately observed from provider responses. Missing fields remain null/incomplete; reservations are not usage.",
    seedKind: "14 deterministic imported fixture turns; only subsequent OpenCode calls are real LLM usage", requestedRuns: todo.length, completedRuns: records.length,
    budgets: budget.snapshot(), incomplete: commands.signal.aborted || budget.snapshot().violation || !budget.snapshot().usageComplete || records.length !== todo.length || records.some(r => r.incomplete), records, requests })
  const save = async () => { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(options.output, JSON.stringify(report(), null, 2) + "\n") }
  let next = 0
  try {
    hostVersion = (await commands.command(["opencode", "--version"], root, {}, 10000)).stdout.trim()
    await Promise.all(Array.from({ length: Math.min(4, options.concurrency ?? 2) }, async () => {
      while (next < todo.length && !budget.snapshot().exhausted && !commands.signal.aborted) {
        const work = todo[next++]!, id = `${work.task.id}-${work.arm}-${work.repeat}`
        const record = await runTask(root, id, work.task, work.arm, work.repeat, options, proxy.url.origin, model, key, commands.command).catch(error => ({ id, task: work.task.id, arm: work.arm, repeat: work.repeat, passed: false, incomplete: true, reason: safe(error instanceof Error ? error.message : String(error), key), usage: { input: null, output: null, cacheRead: null, cacheWrite: null, cost: null }, usageComplete: false }))
        await finishRequests(id)
        const summary = requests.filter(request => request.run === id && request.kind === "summary")
        const summaryUsage = { input: nullableSum(summary.map(request => request.actualInput)), output: nullableSum(summary.map(request => request.actualOutput)), requests: summary.length, complete: summary.every(request => request.usageComplete) }
        const totalUsage = { input: nullableSum([record.usage.input, record.usage.cacheRead, record.usage.cacheWrite, summaryUsage.input]), output: nullableSum([record.usage.output, summaryUsage.output]), complete: record.usageComplete && summaryUsage.complete }
        Object.assign(record, { summaryUsage, totalUsage, incomplete: record.incomplete || !totalUsage.complete })
        records.push(record); await save()
        console.log(JSON.stringify({ run: id, passed: record.passed, incomplete: record.incomplete, input: record.usage.input, output: record.usage.output, requests: requests.filter(r => r.run === id).length }))
      }
    }))
    await save(); return report()
  } finally {
    commands.abort(); proxy.stop(true)
    await commands.close()
    await Promise.allSettled([...activeRequests.values()].map(entry => entry.done))
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt)
    await rm(root, { recursive: true, force: true })
  }
}

async function boundedResponse(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("Provider response exceeds observation limit") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}

async function runTask(root:string,id:string,task:LiveTask,arm:string,repeat:number,options:LiveOptions,proxy:string,model:string,key:string,command:Command) {
  const sandbox=join(root,id),workdir=join(sandbox,"work")
  await mkdir(join(workdir,"src"),{recursive:true})
  const manifest=JSON.stringify({type:"module",scripts:{test:"bun test.mjs"}})+"\n"
  await writeFile(join(workdir,"package.json"),manifest)
  for(const [path,content] of Object.entries(task.files)) await writeFile(join(workdir,path),content)
  const verifier=verifierFor(task)
  if(!task.files["test.mjs"]) await writeFile(join(workdir,"test.mjs"),verifier)
  const sessionId=`ses_${randomUUID().replaceAll("-","")}`
  const seedPath=join(sandbox,"seed.json")
  await writeFile(seedPath,JSON.stringify(seedSession(task,workdir,sessionId,model)))
  const config={model:options.model,small_model:options.model,autoupdate:false,share:"disabled",compaction:{auto:false,prune:false},
    provider:{opencode:{options:{apiKey:`{env:${options.apiKeyEnv}}`,baseURL:`${proxy}/${id}/main`},models:{[model]:{limit:{context:40000,input:40000,output:2048}}}}},
    agent:{build:{steps:8,model:options.model}},permission:{"*":"deny",read:"allow",edit:"allow",write:"allow",glob:"allow",grep:"allow",list:"allow",bash:"allow",headroom_retrieve:"allow"},
    plugin:[[new URL("./live-plugin.ts",import.meta.url).href,{dataDir:join(sandbox,"bluecode"),rtk:{mode:"off"},headroom:{strategy:arm==="legacy"?"legacy":"layered",memoryMaxTokens:128,idleExitMs:1000,
      ...(arm==="enhanced"?{summarizer:{enabled:true,baseURL:`${proxy}/${id}/summary`,model,apiKeyEnv:options.apiKeyEnv}}:{})}}]]}
  const env={BLUECODE_LIVE_TRACE:join(sandbox,"trace.jsonl"),OPENCODE_CONFIG_CONTENT:JSON.stringify(config),XDG_CONFIG_HOME:join(sandbox,"config"),XDG_DATA_HOME:join(sandbox,"data"),XDG_STATE_HOME:join(sandbox,"state"),XDG_CACHE_HOME:join(root,"cache"),[options.apiKeyEnv]:key}
  const started=performance.now()
  const imported=await command(["opencode","import","--pure",seedPath],workdir,{...env,OPENCODE_CONFIG_CONTENT:JSON.stringify({...config,plugin:[]})},30000)
  if(imported.code!==0||!imported.stdout.includes("Imported session:")) return {id,task:task.id,arm,repeat,passed:false,incomplete:true,reason:"fixture-import-failed",detail:safe(imported.stderr,key).slice(-1600),usage:{input:null,output:null,cacheRead:null,cacheWrite:null,cost:null},usageComplete:false,durationMs:performance.now()-started}
  const prompt=`Continue the pending task: ${task.request} Inspect the current source, make the change, and run bun test.mjs. The earlier task contract remains binding. Write handoff.json with four short strings: fact (copy the earlier contract sentence verbatim), file (src/main.js or test.mjs changed), next (verification status or remaining action), reason (copy the earlier rationale verbatim). No dependencies or network access are needed.`
  const run=await command(["opencode","run","--format","json","--model",options.model,"--session",sessionId,"--title",`Headroom ${id}`,"--dir",workdir,prompt],workdir,env,180000)
  const events=run.stdout.split("\n").flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
  const measured = mainUsage(events)
  const { complete, ...usage } = measured
  const validation = await validateTask(workdir, task, manifest, task.files["test.mjs"] ?? verifier, command)
  let handoff:any=null
  try {handoff=JSON.parse(await readFile(join(workdir,"handoff.json"),"utf8"))}catch{}
  const probes=probesFor(handoff,task)
  const toolEvents=events.filter(e=>e.type==="tool_use"), toolCounts:Record<string,number>={}
  for(const event of toolEvents){const tool=event.part?.tool??"unknown";toolCounts[tool]=(toolCounts[tool]??0)+1}
  let trace:unknown[]=[]
  try { trace=(await readFile(join(sandbox,"trace.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line)) } catch {}
  const visibleNodes = trace.flatMap((event: any) => event.event === "transform" && Array.isArray(event.nodeIds) ? event.nodeIds : [])
  const candidates = readCandidates(join(sandbox,"bluecode","storage-v2","headroom","meta.db"), sessionId, visibleNodes)
  const usageComplete = complete && !run.timedOut && !run.aborted && !run.outputTruncated && run.code === 0 && !events.some(event => event.type === "error")
  return {id,task:task.id,category:task.category,arm,repeat,trace,candidates,compressionApplied:trace.some((event:any)=>event.event==="transform"&&event.afterChars<event.beforeChars),...validation,probes,handoff,
    incomplete:!usageComplete || (arm === "enhanced" && !candidates.complete),exitCode:run.code,timedOut:run.timedOut,aborted:run.aborted,usage,usageComplete,toolCounts,durationMs:performance.now()-started,
    errors:events.filter(e=>e.type==="error").map(e=>safe(JSON.stringify(e),key).slice(0,1000)),stderr:safe(run.stderr,key).slice(-1500),
    validationError:validation.validationError?safe(validation.validationError,key).slice(-1200):null}
}
