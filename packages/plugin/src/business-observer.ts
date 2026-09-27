/** Minimal production-code observer used by isolated business evaluations. */
import bluecodePlugin from "./index"

type Input = Parameters<typeof bluecodePlugin>[0]
type Options = Parameters<typeof bluecodePlugin>[1]
type Hooks = Awaited<ReturnType<typeof bluecodePlugin>>

export default async function businessObserver(input: Input, options?: Options): Promise<Hooks> {
  const url = process.env.BLUECODE_BUSINESS_TRACE_URL
  const token = process.env.BLUECODE_BUSINESS_TRACE_TOKEN
  delete process.env.BLUECODE_BUSINESS_TRACE_TOKEN
  let pending = Promise.resolve()
  const record = (event: Record<string, unknown>) => {
    pending = pending.then(async () => {
      if (!url || !token) throw Error("Business trace receiver unavailable")
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ at: new Date().toISOString(), ...event }), signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw Error(`Business trace receiver rejected ${response.status}`)
    })
    return pending
  }
  const hooks = await bluecodePlugin(input, options, { trace: value => { void record({ type: "runtime", ...value }).catch(() => undefined) } })
  await record({ type: "factory", compressionMode: (options as any)?.mode, securityMode: (options as any)?.security?.mode })
  const after = hooks["tool.execute.after"]
  hooks["tool.execute.after"] = async (event, output) => {
    const before = typeof output.output === "string" ? output.output.length : null
    await after?.(event, output)
    const afterLength = typeof output.output === "string" ? output.output.length : null
    await record({ type: "tool", tool: event.tool, callId: event.callID, beforeChars: before, afterChars: afterLength,
      rtkCompressed: output.metadata?.bluecode?.compressed === true, securityWithheld: output.metadata?.vsec?.withheld === true })
  }
  const transform = hooks["experimental.chat.messages.transform"]
  hooks["experimental.chat.messages.transform"] = async (event, output) => {
    const beforeChars = JSON.stringify(output.messages).length
    await transform?.(event, output)
    const text = JSON.stringify(output.messages)
    await record({ type: "transform", beforeChars, afterChars: text.length,
      nodeIds: [...text.matchAll(/\[headroom node:([0-9a-f]{64})\]/g)].map(match => match[1]!) })
  }
  return hooks
}
