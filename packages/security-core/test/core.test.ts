import { describe, expect, test } from "bun:test"
import type { SecurityEvaluateParams, SecurityPolicy } from "@bluecode/contracts"
import * as core from "../src/index"

const api = core as unknown as { evaluateTool: (p:SecurityEvaluateParams)=>Promise<any>; sanitizeFields:(p:any)=>any; defaultSecurityPolicy:()=>SecurityPolicy }
const namespace = { projectId: "project", sessionId: "session" }
function input(content = "", path = "/project/src/main.ts"): SecurityEvaluateParams {
  return { namespace, tool: "write", args: {}, cwd: "/project", root: "/project", files: [{ path, content, complete: true }], paths: [], policy: { version: "vsec-1", exceptions: [], deniedPaths: [], mcpTools: {} } }
}
const token = "ghp_" + "Ab9cD8eF7gH6iJ5kL4mN3oP2qR1sT0uV9wX8"

test("Core implements approved exports", () => {
  expect(api.evaluateTool).toBeFunction()
  expect(api.sanitizeFields).toBeFunction()
  expect(api.defaultSecurityPolicy).toBeFunction()
})
test("New credentials deny but unchanged existing credentials warn", async () => {
  const p = input(`const token = "${token}"`)
  expect((await api.evaluateTool(p)).decision).toBe("deny")
  p.files[0]!.before = p.files[0]!.content
  const existing = await api.evaluateTool(p)
  expect(existing.decision).toBe("warn")
  expect(existing.diagnostics).toContain("existing-findings")
  expect(JSON.stringify(existing)).not.toContain(token)
})
test("Redaction is local, idempotent, and retains newlines and neighboring requirements", () => {
  const fields = [`Keep UI labels\nAPI_TOKEN=${token}\nKeep accessibility`, "-----BEGIN PRIVATE KEY-----\nYWJjZGVm\n-----END PRIVATE KEY-----\nKeep path"]
  const p = { namespace, fields, policy: input().policy }
  const r = api.sanitizeFields(p)
  expect(r.redactions).toBe(2)
  expect(r.fields[0]).toContain("Keep UI labels")
  expect(r.fields[0]).toContain("Keep accessibility")
  expect(r.fields.join("\n")).not.toContain(token)
  expect(r.fields[1]!.split("\n").length).toBe(fields[1]!.split("\n").length)
  expect(api.sanitizeFields({ ...p, fields: r.fields }).fields).toEqual(r.fields)
  expect(api.sanitizeFields({ ...p, fields: r.fields }).redactions).toBe(0)
})
test("Exceptions match exact rule, path subtree boundary, reason and future expiry", async () => {
  const p = input(`const token = "${token}"`)
  const first = await api.evaluateTool(p)
  p.policy.exceptions = [{ ruleId: first.findings[0].ruleId, scope: "/project/src", reason: "intentional fixture", expiresAt: "2099-01-01T00:00:00Z" }]
  expect((await api.evaluateTool(p)).decision).toBe("allow")
  p.policy.exceptions[0]!.scope = "/project/s"
  expect((await api.evaluateTool(p)).decision).toBe("deny")
  p.policy.exceptions[0]!.scope = "/project/src"
  p.policy.exceptions[0]!.expiresAt = "2000-01-01T00:00:00Z"
  expect((await api.evaluateTool(p)).decision).toBe("deny")
})
test("Oversize content fails closed without scanning only a prefix", async () => {
  const p = input("x".repeat(1024 * 1024 + 1))
  expect((await api.evaluateTool(p)).decision).toBe("unavailable")
  const r = api.sanitizeFields({ namespace, fields: [p.files[0]!.content], policy: p.policy })
  expect(r.coverage).toBe("unsupported")
  expect(r.fields[0]).toContain("unavailable")
})
test("Partial candidates and malformed code never claim complete coverage", async () => {
  const p = input("const a = 1")
  p.files[0]!.complete = false
  expect((await api.evaluateTool(p)).coverage).toBe("partial")
  expect((await api.evaluateTool(input("const = {"))).coverage).toBe("partial")
})
test("Paths use resolved boundaries; safe internal dotdot and public keys are allowed", async () => {
  const p = input()
  p.paths = [{ path: "src/../README.md", resolvedPath: "/project/README.md", operation: "read" }, { path: "id_rsa.pub", resolvedPath: "/project/id_rsa.pub", operation: "read" }]
  expect((await api.evaluateTool(p)).decision).toBe("allow")
  p.paths = [{ path: "link/file", resolvedPath: "/project-other/file", operation: "write" }]
  expect((await api.evaluateTool(p)).decision).toBe("deny")
})
test("Unknown tools report incomplete semantic coverage", async () => {
  const p = input()
  p.tool = "mcp_unknown"
  expect((await api.evaluateTool(p)).coverage).toBe("partial")
})

test("Generated values, template references and low-information examples are not credentials", async () => {
  for (const content of ['const token = generateToken()', 'const password = userInput', 'const secret = config.secret', 'API_TOKEN=${MY_LONG_TOKEN_VARIABLE}', 'PASSWORD=your_password_here', 'const apiKey = "aaaaaaaaaaaaaaaaaaaaaaaa"']) {
    expect((await api.evaluateTool(input(content))).findings.filter((f:any)=>f.category==='credential')).toHaveLength(0)
  }
})
test("Bash literal recursion inspects command chains containing expansions", async () => {
  for (const command of ["sh -c 'echo $USER; rm -rf /'", 'sudo -n -- rm -rf /', 'rm -rf /project/..', 'rm -rf .', 'sh -c \'rm -rf "$HOME"\'']) {
    const p = input(); p.tool='bash'; p.args={command}
    expect((await api.evaluateTool(p)).decision).toBe('deny')
  }
})
test("Bash nested shell depth and dynamic unsupported syntax disclose coverage", async () => {
  for (const command of ['sh -c "$DYNAMIC"', 'echo $(cat "$FILE")', "bash -c 'sh -c \"sh -c true\"'"]) {
    const p=input();p.tool='bash';p.args={command}
    expect((await api.evaluateTool(p)).coverage).toBe('partial')
  }
})
test("Exceptions never bypass mandatory redaction", () => {
  const p = {namespace,fields:[token],policy:input().policy}
  p.policy.exceptions=[{ruleId:'credential.github',scope:'*',reason:'fixture',expiresAt:'2099-01-01T00:00:00Z'}]
  expect(api.sanitizeFields(p).fields[0]).not.toContain(token)
})
test("Duplicate new credential occurrences are distinguished from existing ones",async()=>{
  const p=input(`const a="${token}";const b="${token}"`)
  p.files[0]!.before=`const a="${token}"`
  expect((await api.evaluateTool(p)).decision).toBe('deny')
})
test("Malformed argument graphs and aggregate oversized input are rejected safely",async()=>{
  const p=input(); const cyclic:Record<string,unknown>={}; cyclic.self=cyclic;p.args=cyclic
  expect((await api.evaluateTool(p)).decision).toBe('unavailable')
  p.args={fields:Array.from({length:9},()=>"a".repeat(1024*1024))}
  expect((await api.evaluateTool(p)).decision).toBe('unavailable')
})

test("Long contextual secrets are redacted entirely, not only a bounded prefix",()=>{
  const value='Ab9cDeF0'.repeat(1000)
  const result=api.sanitizeFields({namespace,policy:input().policy,fields:[`password=${value}\nKeep UI`, `password="${value}"\nKeep API`]})
  expect(result.fields[0]).toBe('password=[REDACTED]\nKeep UI')
  expect(result.fields[1]).toBe('password="[REDACTED]"\nKeep API')
})
test("Quoted credential escaping cannot leave a secret suffix behind",()=>{
  const result=api.sanitizeFields({namespace,policy:input().policy,fields:['password="abcDEF12\\"SECRET_SUFFIX"; keep=true']})
  expect(result.fields[0]).toBe('password="[REDACTED]"; keep=true')
})

test("Confirmed sensitive file access denies while examples and public keys remain allowed",async()=>{
  for (const file of ['.env','.ssh/id_rsa']) {
    const p=input();p.tool='read';p.paths=[{path:file,resolvedPath:'/project/'+file,operation:'read'}]
    expect((await api.evaluateTool(p)).decision).toBe('deny')
  }
})
test("Removing a credential via edit or patch does not reintroduce it through old evidence",async()=>{
  const p=input('const safe = true');p.files[0]!.before=`const token="${token}"`
  p.tool='edit';p.args={oldString:p.files[0]!.before,newString:p.files[0]!.content}
  expect((await api.evaluateTool(p)).decision).toBe('allow')
  p.tool='apply_patch';p.args={patchText:`*** Begin Patch\n*** Update File: a.ts\n-${p.files[0]!.before}\n+${p.files[0]!.content}\n*** End Patch`}
  expect((await api.evaluateTool(p)).decision).toBe('allow')
})
