import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { join, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { liveTasks, seedSession, type LiveTask } from "./live-tasks"

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
  const records: any[]=[]
  const requests: any[]=[]
  let reservedInput=0,reservedOutput=0,exhausted=false
  const proxy=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:120,async fetch(request) {
    const url=new URL(request.url), match=url.pathname.match(/^\/([a-zA-Z0-9-]+)\/(main|summary)\/chat\/completions$/)
    if(!match || request.method!=="POST") return new Response("Unknown evaluation route",{status:404})
    const body=await request.json() as any
    if(body.model!==model) return new Response("Model outside free-only allowlist",{status:403})
    const requestedOutput=Number(body.max_tokens)
    const input=Math.ceil(JSON.stringify(body).length/3), output=Number.isSafeInteger(requestedOutput)&&requestedOutput>0?Math.min(requestedOutput,2048):2048
    const perRun=requests.filter(r=>r.run===match[1] && r.kind==="main").length
    if(requests.length>=options.maxRequests || reservedInput+input>options.maxInputTokens || reservedOutput+output>options.maxOutputTokens) {
      exhausted=true; return new Response("Explicit evaluation budget exhausted",{status:402})
    }
    if (perRun>=8) return new Response("This task reached its eight-request limit",{status:402})
    reservedInput+=input; reservedOutput+=output
    body.max_tokens=output
    const encoded=JSON.stringify(body)
    const record:any={run:match[1],kind:match[2],headroomMarkers:(encoded.match(/\[headroom node:/g)??[]).length,messages:body.messages?.length,inputReservation:input,outputReservation:output,hasHostSession:request.headers.has("x-opencode-session"),status:null,durationMs:0}
    requests.push(record)
    const headers=new Headers(request.headers)
    headers.delete("host"); headers.delete("content-length"); headers.delete("accept-encoding")
    // Forward only real host headers. The summary adapter intentionally has no fabricated session identity.
    headers.set("authorization",`Bearer ${key}`)
    const start=performance.now()
    try {
      const response=await fetch("https://opencode.ai/zen/v1/chat/completions",{method:"POST",headers,body:JSON.stringify(body),signal:AbortSignal.timeout(90000),redirect:"error"})
      record.status=response.status
      console.log(JSON.stringify({request:record.run,kind:record.kind,status:record.status,hostSession:record.hasHostSession,headroomMarkers:record.headroomMarkers}))
      const bytes=await response.arrayBuffer()
      record.durationMs=performance.now()-start
      const outHeaders=new Headers(response.headers)
      outHeaders.delete("content-encoding");outHeaders.delete("content-length");outHeaders.delete("transfer-encoding")
      return new Response(bytes,{status:response.status,headers:outHeaders})
    } catch { record.status="transport-error";record.durationMs=performance.now()-start;return new Response("Evaluation upstream unavailable",{status:502}) }
  }})
  const hostVersion=await command(["opencode","--version"],root,{},10000)
  const todo=liveTasks().filter(task=>!options.tasks||options.tasks.includes(task.id)).flatMap(task=>
    Array.from({length:options.repeats??2},(_,repeat)=>(options.arms??["legacy","layered","enhanced"]).map(arm=>({task,repeat,arm}))).flat())
  const report=()=>({version:1,baseline:"62589ac",model:options.model,concurrency:options.concurrency??2,hostVersion:hostVersion.stdout.trim(),monetaryBudget:0,
    usageMode:"OpenCode tokens.input excludes cache; logical prompt tokens = input + cacheRead + cacheWrite. Missing steps imply incomplete usage; never infer zero charge from missing usage.",seedKind:"14 deterministic imported fixture turns; only subsequent OpenCode calls are real LLM usage",requestedRuns:todo.length,completedRuns:records.length,
    budgets:{maxRequests:options.maxRequests,maxInputTokens:options.maxInputTokens,maxOutputTokens:options.maxOutputTokens,reservedInput,reservedOutput,exhausted,inputReservationMode:"ceil UTF-16 JSON characters / 3; provider usage reported separately"},
    incomplete:records.length!==todo.length||records.some(r=>r.incomplete),records,requests})
  const save=async()=>{await mkdir(dirname(resolve(options.output)),{recursive:true});await writeFile(options.output,JSON.stringify(report(),null,2)+"\n")}
  let next=0
  try {
    await Promise.all(Array.from({length:Math.min(4,options.concurrency??2)},async()=>{
      while(next<todo.length && !exhausted) {
        const work=todo[next++]!, id=`${work.task.id}-${work.arm}-${work.repeat}`
        const record=await runTask(root,id,work.task,work.arm,work.repeat,options,proxy.url.origin,model,key).catch(error=>({id,task:work.task.id,arm:work.arm,repeat:work.repeat,passed:false,incomplete:true,reason:safe(error instanceof Error?error.message:String(error),key),usage:{input:null,output:null,cacheRead:null,cacheWrite:null,cost:null}}))
        records.push(record);await save()
        console.log(JSON.stringify({run:id,passed:record.passed,incomplete:record.incomplete,input:record.usage.input,output:record.usage.output,requests:requests.filter(r=>r.run===id).length}))
      }
    }))
    await save();return report()
  } finally {proxy.stop(true);await rm(root,{recursive:true,force:true})}
}

async function command(argv:string[],cwd:string,env:Record<string,string>,timeoutMs:number) {
  const child=Bun.spawn(argv,{cwd,env:{...process.env,...env},stdout:"pipe",stderr:"pipe"})
  let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill("SIGTERM")},timeoutMs)
  const killer=setTimeout(()=>child.kill("SIGKILL"),timeoutMs+3000)
  try {
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
    return {code,stdout,stderr,timedOut}
  } finally {clearTimeout(timer);clearTimeout(killer)}
}

async function runTask(root:string,id:string,task:LiveTask,arm:string,repeat:number,options:LiveOptions,proxy:string,model:string,key:string) {
  const sandbox=join(root,id),workdir=join(sandbox,"work")
  await mkdir(join(workdir,"src"),{recursive:true})
  const manifest=JSON.stringify({type:"module",scripts:{test:"bun test.mjs"}})+"\n"
  await writeFile(join(workdir,"package.json"),manifest)
  for(const [path,content] of Object.entries(task.files)) await writeFile(join(workdir,path),content)
  const verifier=`import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import * as m from './src/main.js'; ${task.checks}\n`
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
  if(imported.code!==0||!imported.stdout.includes("Imported session:")) return {id,task:task.id,arm,repeat,passed:false,incomplete:true,reason:"fixture-import-failed",detail:safe(imported.stderr,key).slice(-1600),usage:{input:0,output:0,cacheRead:0,cacheWrite:0},durationMs:performance.now()-started}
  const prompt=`Continue the pending task: ${task.request} Inspect the current source, make the change, and run bun test.mjs. The earlier task contract remains binding. Write handoff.json with four short strings: fact (copy the earlier contract sentence verbatim), file (src/main.js or test.mjs changed), next (verification status or remaining action), reason (copy the earlier rationale verbatim). No dependencies or network access are needed.`
  const run=await command(["opencode","run","--format","json","--model",options.model,"--session",sessionId,"--title",`Headroom ${id}`,"--dir",workdir,prompt],workdir,env,180000)
  const events=run.stdout.split("\n").flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0,cost:0}
  for(const event of events) if(event.type==="step_finish") {const t=event.part?.tokens;usage.input+=t?.input??0;usage.output+=t?.output??0;usage.cacheRead+=t?.cache?.read??0;usage.cacheWrite+=t?.cache?.write??0;usage.cost+=event.part?.cost??0}
  const tests=await command(["bun","test.mjs"],workdir,{},10000)
  // Hidden acceptance runs against the final code in addition to the agent-visible test.
  await writeFile(join(workdir,"acceptance.mjs"),verifier)
  const acceptance=await command(["bun","acceptance.mjs"],workdir,{},10000)
  const finalSource=await readFile(join(workdir,"src/main.js"),"utf8"),finalManifest=await readFile(join(workdir,"package.json"),"utf8")
  const constraints=finalManifest===manifest&&(task.category!=="test-repair"||finalSource===task.files["src/main.js"])
  let handoff:any=null
  try {handoff=JSON.parse(await readFile(join(workdir,"handoff.json"),"utf8"))}catch{}
  const probes={fact:typeof handoff?.fact==="string"&&handoff.fact.replace(/[.。]$/,"")===task.fact,file:typeof handoff?.file==="string"&&handoff.file.includes(task.category==="test-repair"?"test.mjs":"src/main.js"),next:typeof handoff?.next==="string"&&handoff.next.length>0,reason:typeof handoff?.reason==="string"&&handoff.reason.replace(/[.。]$/,"")===task.reason}
  const toolEvents=events.filter(e=>e.type==="tool_use"), toolCounts:Record<string,number>={}
  for(const event of toolEvents){const tool=event.part?.tool??"unknown";toolCounts[tool]=(toolCounts[tool]??0)+1}
  let trace:unknown[]=[]
  try { trace=(await readFile(join(sandbox,"trace.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line)) } catch {}
  return {id,task:task.id,category:task.category,arm,repeat,trace,compressionApplied:trace.some((event:any)=>event.event==="transform"&&event.afterChars<event.beforeChars),passed:tests.code===0&&acceptance.code===0&&constraints,constraints,probes,handoff,
    incomplete:run.timedOut||run.code!==0||usage.input===0||events.some(event=>event.type==="error"),exitCode:run.code,timedOut:run.timedOut,usage:events.some(event=>event.type==="step_finish")?usage:{input:null,output:null,cacheRead:null,cacheWrite:null,cost:null},usageComplete:!run.timedOut&&run.code===0&&!events.some(event=>event.type==="error"),toolCounts,durationMs:performance.now()-started,
    errors:events.filter(e=>e.type==="error").map(e=>safe(JSON.stringify(e),key).slice(0,1000)),stderr:safe(run.stderr,key).slice(-1500),
    validationError:acceptance.code===0?null:safe(acceptance.stderr,key).slice(-1200)}
}
