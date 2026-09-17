// Test-only child: the production server has no failure-injection operations.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const dir = process.env.BLUECODE_VSEC_DATA_DIR!
const config = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) as { mode: string; delayMs?: number }
const marker = join(dir, "seen")
if (config.mode === "bad-start") console.log(JSON.stringify({ protocol: 99, type: "ready" }))
else console.log(JSON.stringify({ protocol: 1, type: "ready", pid: process.pid }))
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let next: number
  while ((next = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, next))
    buffer = buffer.slice(next + 1)
    if (request.op === "shutdown") process.exit(0)
    if (request.op === "health") {
      console.log(JSON.stringify({ protocol: 1, id: request.id, ok: true, result: { pid: process.pid, protocol: 1, uptimeMs: 1, cacheBytes: 0, cacheHits: 0, serviceMs: 0, rssBytes: 1000 }, timing: { requestId: request.id, queueMs: request.queueMs, serviceMs: 0, policyVersion: "vsec-1" } }))
      continue
    }
    if (config.mode === "hang-once" && !existsSync(marker)) { writeFileSync(marker, "seen"); while (true) {} }
    if (config.mode === "crash-once" && !existsSync(marker)) { writeFileSync(marker, "seen"); console.error("sensitive-stderr-canary"); process.exit(9) }
    if (config.mode === "oversized") { process.stdout.write("x".repeat(9 * 1024 * 1024)); continue }
    if (config.mode === "invalid") { console.log('{"secret":"sensitive-protocol-canary"}'); continue }
    const result = { fields: request.params.fields, redactions: 0, coverage: "complete", policyVersion: request.params.policy.version }
    const reply = () => console.log(JSON.stringify({ protocol: 1, id: request.id, ok: true, result, timing: { requestId: request.id, queueMs: request.queueMs, serviceMs: 0, policyVersion: result.policyVersion } }))
    if (config.mode === "delay") await Bun.sleep(config.delayMs ?? 100)
    reply()
    if (config.mode === "duplicate") setTimeout(reply, 5)
  }
}
