/** Host filesystem knowledge belongs here; scanners receive immutable snapshots. */
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { SecurityEvaluateParams, SecurityFile, SecurityPath, SecurityPolicy } from "@bluecode/contracts"

const LIMIT = 1024 ** 2
export function toolOperation(tool: string, policy: SecurityPolicy): "read" | "write" | "execute" | "unknown" {
  if (["read", "glob", "grep", "ls", "headroom_retrieve", "list_mcp_resources", "read_mcp_resource"].includes(tool)) return "read"
  if (["write", "edit", "apply_patch"].includes(tool)) return "write"
  if (["bash", "shell", "task", "code"].includes(tool)) return "execute"
  return policy.mcpTools[tool]?.operation ?? "unknown"
}

export async function canonicalPath(input: string): Promise<string> {
  let current = path.resolve(input)
  const missing: string[] = []
  for (;;) {
    try { return path.join(await realpath(current), ...missing.reverse()) }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error("Path resolution unavailable")
      const parent = path.dirname(current)
      if (parent === current) throw new Error("Path resolution unavailable")
      missing.push(path.basename(current)); current = parent
    }
  }
}

async function contents(file: string): Promise<string | undefined> {
  try {
    const metadata = await stat(file)
    if (!metadata.isFile() || metadata.size > LIMIT) throw new Error("File exceeds security scan limit")
    const value = await readFile(file, { encoding: "utf8", signal: AbortSignal.timeout(1000) })
    if (Buffer.byteLength(value) > LIMIT) throw new Error("File exceeds security scan limit")
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("File snapshot unavailable")
  }
}

function field(args: Record<string, unknown>, name: string): unknown {
  let item: any = args
  for (const key of name.split(".")) item = item && typeof item === "object" ? item[key] : undefined
  return item
}

export async function prepareTool(input: {
  projectId: string; sessionId: string; directory: string; root: string;
  tool: string; args: unknown; policy: SecurityPolicy
}): Promise<SecurityEvaluateParams> {
  const args = input.args && typeof input.args === "object" && !Array.isArray(input.args)
    ? structuredClone(input.args) as Record<string, unknown> : {}
  const cwd = await canonicalPath(path.resolve(input.directory,
    typeof args.workdir === "string" && ["bash", "shell"].includes(input.tool) ? args.workdir : "."))
  const root = await canonicalPath(input.root)
  const files: SecurityFile[] = [], paths: SecurityPath[] = []
  let incomplete = false
  const addPath = async (name: string, operation: SecurityPath["operation"]) => {
    const absolute = path.resolve(cwd, name)
    const resolvedPath = await canonicalPath(absolute)
    paths.push({ path: absolute, resolvedPath, operation })
    return absolute
  }
  const addFile = async (name: string, content: string, complete = true) => {
    const file = await addPath(name, "write")
    const before = await contents(file)
    files.push({ path: file, content, complete, ...(before !== undefined ? { before } : {}) })
  }
  if (input.tool === "write" && typeof args.filePath === "string" && typeof args.content === "string") {
    await addFile(args.filePath, args.content)
  } else if (input.tool === "edit" && typeof args.filePath === "string" && typeof args.newString === "string") {
    const file = await addPath(args.filePath, "write")
    const before = await contents(file)
    const old = typeof args.oldString === "string" ? args.oldString : ""
    let candidate = args.newString, complete = false
    if (typeof args.oldString === "string" && old === "") complete = true
    else if (before !== undefined && old !== "" && before.includes(old) &&
      (args.replaceAll === true || before.indexOf(old) === before.lastIndexOf(old))) {
      candidate = args.replaceAll === true ? before.replaceAll(old, args.newString) : before.replace(old, () => args.newString as string)
      complete = true
    }
    files.push({ path: file, content: candidate, complete, ...(before !== undefined ? { before } : {}) })
    incomplete ||= !complete
  } else if (input.tool === "apply_patch" && typeof args.patchText === "string") {
    const lines = args.patchText.split("\n")
    if (lines[0] !== "*** Begin Patch" || !lines.includes("*** End Patch")) incomplete = true
    for (let i = 0; i < lines.length; i++) {
      const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i]!)
      if (!match) continue
      const kind = match[1]!, name = match[2]!
      const file = await addPath(name, kind === "Delete" ? "delete" : "write")
      const before = await contents(file)
      const body: string[] = []
      let destination: string | undefined
      while (i + 1 < lines.length && !/^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch/.test(lines[i + 1]!)) {
        const line = lines[++i]!
        if (line.startsWith("*** Move to: ")) destination = await addPath(line.slice(13), "write")
        else body.push(line)
      }
      if (kind === "Delete") continue
      let content = body.filter(line => line.startsWith("+")).map(line => line.slice(1)).join("\n")
      let complete = false
      if (kind === "Add" && body.every(line => line.startsWith("+") || line === "")) {
        content += "\n"; complete = true
      } else if (kind === "Update" && before !== undefined) {
        let candidate = before, good = true
        const hunks: string[][] = [[]]
        for (const line of body) {
          if (line.startsWith("@@")) { if (hunks.at(-1)!.length) hunks.push([]) }
          else if (line !== "*** End of File" && line !== "") hunks.at(-1)!.push(line)
        }
        for (const hunk of hunks.filter(h => h.length)) {
          if (hunk.some(line => !/^[ +\-]/.test(line))) { good = false; break }
          const old = hunk.filter(line => line[0] !== "+").map(line => line.slice(1)).join("\n")
          const next = hunk.filter(line => line[0] !== "-").map(line => line.slice(1)).join("\n")
          if (!old || candidate.indexOf(old) < 0 || candidate.indexOf(old) !== candidate.lastIndexOf(old)) { good = false; break }
          candidate = candidate.replace(old, () => next)
        }
        if (good && hunks.some(h => h.length)) { content = candidate; complete = true }
      }
      files.push({ path: destination ?? file, content, complete, ...(before !== undefined ? { before } : {}) })
      incomplete ||= !complete
    }
    if (!paths.length) incomplete = true
  } else {
    const mapping = input.policy.mcpTools[input.tool]
    const operation = toolOperation(input.tool, input.policy)
    const names = mapping?.pathFields ?? (["read", "glob", "grep", "ls"].includes(input.tool) ? ["filePath", "path"] : [])
    for (const key of names) {
      const value = field(args, key)
      if (typeof value === "string") await addPath(value, operation === "read" ? "read" : "write")
    }
    for (const key of mapping?.contentFields ?? []) {
      const value = field(args, key)
      if (typeof value === "string") files.push({ path: paths[0]?.path ?? "unknown.txt", content: value, complete: false })
    }
    if (mapping && files.length) incomplete = true
    if (["write", "edit", "apply_patch"].includes(input.tool)) incomplete = true
  }
  return { namespace: { projectId: input.projectId, sessionId: input.sessionId }, tool: input.tool,
    args, cwd, root, files, paths, policy: input.policy, ...(incomplete ? { incomplete } : {}) }
}
