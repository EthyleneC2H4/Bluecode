import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { securityPolicySchema } from "@bluecode/contracts"
import { canonicalPath, prepareTool, toolOperation } from "../src/security-tools"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "vsec-tools-")); dirs.push(dir)
  const run = (tool: string, args: any, policy = securityPolicySchema.parse({})) => prepareTool({
    projectId: "p", sessionId: "s", directory: dir, root: dir, tool, args, policy,
  })
  return { dir, run }
}

test("new files resolve through existing symlink parents", async () => {
  const { dir, run } = await fixture()
  await mkdir(path.join(dir, "target")); await symlink("target", path.join(dir, "link"))
  const result = await run("write", { filePath: "link/new.ts", content: "const safe = 1" })
  expect(result.paths[0]!.resolvedPath).toBe(path.join(await canonicalPath(dir), "target/new.ts"))
  expect(result.files[0]!.complete).toBe(true)
})

test("ambiguous edits inspect inserted text and declare partial reconstruction", async () => {
  const { dir, run } = await fixture()
  await writeFile(path.join(dir, "a.ts"), "const a = 1\nconst b = 1\n")
  const result = await run("edit", { filePath: "a.ts", oldString: "1", newString: "eval(x)" })
  expect(result.incomplete).toBe(true)
  expect(result.files[0]).toMatchObject({ content: "eval(x)", complete: false })
})

test("multi-file patches include additions, move destinations and deletions", async () => {
  const { dir, run } = await fixture()
  await writeFile(path.join(dir, "a.ts"), "const a = 1\n")
  const result = await run("apply_patch", { patchText: "*** Begin Patch\n*** Add File: b.ts\n+const b = 2\n*** Update File: a.ts\n*** Move to: c.ts\n@@\n-const a = 1\n+const a = 3\n*** Delete File: d.ts\n*** End Patch" })
  expect(result.paths.map(p => [path.basename(p.path), p.operation])).toEqual([
    ["b.ts", "write"], ["a.ts", "write"], ["c.ts", "write"], ["d.ts", "delete"],
  ])
  expect(result.files.map(f => [path.basename(f.path), f.content, f.complete])).toEqual([
    ["b.ts", "const b = 2\n", true], ["c.ts", "const a = 3\n", true],
  ])
})

test("mapped MCP fields use configured nested paths, without trusting self-declared readOnly", async () => {
  const { run } = await fixture()
  const policy = securityPolicySchema.parse({ mcpTools: { remote_save: {
    operation: "write", pathFields: ["document.path"], contentFields: ["document.text"],
  } } })
  const result = await run("remote_save", { document: { path: "a.ts", text: "eval(x)" }, readOnly: true }, policy)
  expect(result.paths[0]!.operation).toBe("write")
  expect(result.files[0]).toMatchObject({ content: "eval(x)", complete: false })
  expect(toolOperation("unknown_tool", policy)).toBe("unknown")
})

test("malformed built-in arguments never claim a complete preview", async () => {
  const { run } = await fixture()
  expect((await run("write", { filePath: "x.ts" })).incomplete).toBe(true)
  expect((await run("apply_patch", { patchText: "invalid patch" })).incomplete).toBe(true)
})

test("empty-oldString edit represents the host whole-file overwrite", async () => {
  const { dir, run } = await fixture()
  await writeFile(path.join(dir, "a.ts"), "const old = 1\n")
  const result = await run("edit", { filePath: "a.ts", oldString: "", newString: "const next = 2\n" })
  expect(result.files[0]).toMatchObject({ before: "const old = 1\n", content: "const next = 2\n", complete: true })
})

test("single edits and patches preserve literal replacement metacharacters in the preview", async () => {
  const { dir, run } = await fixture()
  const before = 'echo safe\n#"', replacement = 'printf "$\'"; rm -rf /'
  await writeFile(path.join(dir, "target.sh"), before)
  const edit = await run("edit", { filePath: "target.sh", oldString: "echo safe", newString: replacement })
  expect(edit.files[0]!.content).toBe(replacement + '\n#"')
  const patch = await run("apply_patch", { patchText: `*** Begin Patch\n*** Update File: target.sh\n@@\n-echo safe\n+${replacement}\n*** End Patch` })
  expect(patch.files[0]!.content).toBe(replacement + '\n#"')
})
