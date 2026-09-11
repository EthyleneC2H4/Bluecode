/** Evaluation-only observation wrapper around the unmodified production plugin factory. */
import bluecodePlugin from "@bluecode/plugin"
import { appendFileSync } from "node:fs"
type PluginInput=Parameters<typeof bluecodePlugin>[0]
type PluginOptions=Parameters<typeof bluecodePlugin>[1]
type Hooks=Awaited<ReturnType<typeof bluecodePlugin>>
export default async function livePlugin(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const record=(value:unknown)=>{const file=process.env.BLUECODE_LIVE_TRACE;if(file)appendFileSync(file,JSON.stringify(value)+"\n")}
  const hooks=await bluecodePlugin(input,options,{trace:record})
  record({event:"factory",configuredStrategy:(options as any)?.headroom?.strategy})
  const transform=hooks["experimental.chat.messages.transform"]
  hooks["experimental.chat.messages.transform"]=async(event,output)=>{
    const before=JSON.stringify(output.messages).length
    await transform?.(event,output)
    const text=JSON.stringify(output.messages)
    record({event:"transform",messages:output.messages.length,beforeChars:before,afterChars:text.length,nodeMarkers:(text.match(/\[headroom node:/g)??[]).length})
  }
  const params=hooks["chat.params"]
  hooks["chat.params"]=async(event,output)=>{await params?.(event,output);record({event:"model",limit:event.model.limit,maxOutputTokens:output.maxOutputTokens})}
  return hooks
}
