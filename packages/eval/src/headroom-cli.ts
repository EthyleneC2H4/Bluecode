import { writeFile } from "node:fs/promises"
import { runHeadroomEvaluation } from "./headroom-runner"
import { engineeringHeadroomFixture } from "./headroom-fixtures"
const args=process.argv.slice(2)
const index=args.indexOf("--output"), output=index<0?"packages/eval/headroom-layered-results.json":args[index+1]
if(!output)throw Error("--output requires a file")
const result=await runHeadroomEvaluation({onProgress:console.log,...(args.includes("--engineering")?{fixtures:[engineeringHeadroomFixture()]}:{})})
await writeFile(output,JSON.stringify(result,null,2)+"\n")
console.log(JSON.stringify({file:output,comparisons:result.comparisons.length,comparable:result.comparisons.filter(c=>c.savingsRatio!==null).length,target25PercentMet:result.comparisons.filter(c=>c.target25PercentMet).length}))
