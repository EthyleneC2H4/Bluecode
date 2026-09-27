/** Minimal production-code observer used by isolated business evaluations. */
import bluecodePlugin from "./index"
import { appendFileSync } from "node:fs"

type Input = Parameters<typeof bluecodePlugin>[0]
type Options = Parameters<typeof bluecodePlugin>[1]
type Hooks = Awaited<ReturnType<typeof bluecodePlugin>>

export default async function businessObserver(input: Input, options?: Options): Promise<Hooks> {
  const path = process.env.BLUECODE_BUSINESS_TRACE
  const record = (event: Record<string, unknown>) => { if (path) appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n") }
  const hooks = await bluecodePlugin(input, options, { trace: value => record({ type: "runtime", ...value }) })
  record({ type: "factory", compressionMode: (options as any)?.mode, securityMode: (options as any)?.security?.mode })
  const after = hooks["tool.execute.after"]
  hooks["tool.execute.after"] = async (event, output) => {
    const before = typeof output.output === "string" ? output.output.length : null
    await after?.(event, output)
    const afterLength = typeof output.output === "string" ? output.output.length : null
    record({ type: "tool", tool: event.tool, callId: event.callID, beforeChars: before, afterChars: afterLength,
      rtkCompressed: output.metadata?.bluecode?.compressed === true, securityWithheld: output.metadata?.vsec?.withheld === true })
  }
  const transform = hooks["experimental.chat.messages.transform"]
  hooks["experimental.chat.messages.transform"] = async (event, output) => {
    const beforeChars = JSON.stringify(output.messages).length
    await transform?.(event, output)
    const text = JSON.stringify(output.messages)
    record({ type: "transform", beforeChars, afterChars: text.length, nodeMarkers: (text.match(/\[headroom node:/g) ?? []).length })
  }
  return hooks
}
