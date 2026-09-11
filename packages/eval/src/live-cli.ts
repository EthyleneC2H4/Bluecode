import { runLiveEvaluation } from "./live-runner"
const args=process.argv.slice(2), value=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1]}
const required=(key:string)=>{const v=value(key);if(!v)throw Error(`Required explicit option: ${key}`);return v}
const result=await runLiveEvaluation({model:required("--model"),apiKeyEnv:required("--api-key-env"),maxRequests:Number(required("--max-requests")),maxInputTokens:Number(required("--max-input-tokens")),maxOutputTokens:Number(required("--max-output-tokens")),output:required("--output"),
  ...(value("--concurrency")?{concurrency:Number(value("--concurrency"))}:{}),
  ...(value("--tasks")?{tasks:value("--tasks")!.split(",")} : {}),...(value("--arms")?{arms:value("--arms")!.split(",") as Array<"legacy"|"layered"|"enhanced">}:{}),...(value("--repeats")?{repeats:Number(value("--repeats"))}:{})})
console.log(JSON.stringify({completedRuns:result.completedRuns,requestedRuns:result.requestedRuns,incomplete:result.incomplete,budgets:result.budgets}))
if(result.incomplete)process.exitCode=2
