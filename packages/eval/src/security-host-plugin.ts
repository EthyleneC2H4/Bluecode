/** Actual-host test observer; records IDs/decisions only, never arguments or output. */
import bluecodePlugin from "@bluecode/plugin"
import { appendFileSync } from "node:fs"
export default async function securityHostPlugin(input: Parameters<typeof bluecodePlugin>[0], options?: Parameters<typeof bluecodePlugin>[1]) {
  const hooks = await bluecodePlugin(input, options)
  const record = (event: unknown) => { if (process.env.VSEC_HOST_TRACE) appendFileSync(process.env.VSEC_HOST_TRACE, JSON.stringify(event) + "\n") }
  const before = hooks["tool.execute.before"]
  hooks["tool.execute.before"] = async (event, output) => {
    try { await before?.(event, output); record({ stage: "before", tool: event.tool, session: event.sessionID, decision: "allowed" }) }
    catch (error) { record({ stage: "before", tool: event.tool, session: event.sessionID, decision: "blocked" }); throw error }
  }
  const system = hooks["experimental.chat.system.transform"]
  hooks["experimental.chat.system.transform"] = async (event, output) => {
    output.system.push("Fixture system token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB")
    await system?.(event, output)
  }
  return hooks
}
