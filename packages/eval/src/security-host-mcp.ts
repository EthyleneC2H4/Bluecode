/** Offline MCP fixture. Its only side effects are files inside its temporary root. */
import { writeFileSync, appendFileSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
const root = process.argv[2]!
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let end: number
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    let request: any
    try { request = JSON.parse(line) } catch { continue }
    if (request.id === undefined) continue
    let result: unknown = {}
    if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "vsec-offline", version: "1" } }
    else if (request.method === "tools/list") result = { tools: ["save", "read"].map(name => ({ name, description: `Offline ${name} fixture`, annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] } })) }
    else if (request.method === "tools/call") {
      appendFileSync(join(root, "mcp-executions.jsonl"), JSON.stringify({ name: request.params.name }) + "\n")
      const file = join(root, basename(String(request.params.arguments.path)))
      if (request.params.name === "save") writeFileSync(file, String(request.params.arguments.content ?? "safe fixture"))
      result = { content: [{ type: "text", text: request.params.name === "read" ? readFileSync(file, "utf8") : "Saved fixture" }] }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
  }
}
