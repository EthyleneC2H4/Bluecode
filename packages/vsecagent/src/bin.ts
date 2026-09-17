import { VsecEngine } from "./engine"
import { finite, readFrames, record, requestId } from "./protocol"

try {
  const dataDir = process.env.BLUECODE_VSEC_DATA_DIR
  if (!dataDir) throw new Error("data-directory-required")
  const engine = await VsecEngine.create({ dataDir })
  console.log(JSON.stringify({ protocol: 1, type: "ready", pid: process.pid }))
  await readFrames(Bun.stdin.stream(), async line => {
    const request: unknown = JSON.parse(line)
    if (!record(request) || request.protocol !== 1 || !requestId(request.id) || !finite(request.queueMs) || !["sanitize", "evaluate", "health"].includes(request.op as string)) throw new Error("protocol")
    console.log(JSON.stringify(await engine.request({ protocol: 1, id: request.id, queueMs: request.queueMs, op: request.op as "sanitize" | "evaluate" | "health", params: request.params })))
  })
} catch { process.exitCode = 1 }
