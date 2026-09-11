import { expect, test } from "bun:test"
import type { ChatMessage } from "@bluecode/contracts"
import * as pure from "../src/pure"

const ns = { projectId: "project", sessionId: "session" }
const options = { namespace: ns, contextWindowTokens: 32_000, targetTokens: 17_600, retainRecentTurns: 4 }
function source(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, n) => [
    { info: { id: `u${n}`, role: "user" as const }, parts: [{ type: "text" as const, text: `Inspect file ${n}. Keep public API unchanged.` }] },
    { info: { id: `a${n}`, role: "assistant" as const }, parts: [{ type: "tool" as const, tool: "read", input: { path: `src/file-${n}.ts` }, state: { status: "completed", output: Array.from({ length: 100 }, (_, line) => `export const unique_${n}_${line} = "value-${n}-${line}"`).join("\n") } }] },
  ]).flat()
}
// Initial red calls through the public host-safe entrypoint, so absent exports fail assertions.
function plan(messages: ChatMessage[], overrides: Record<string, unknown> = {}): any {
  const build = (pure as Record<string, any>).buildLayeredPlan
  expect(typeof build).toBe("function")
  return build(messages, { ...options, ...overrides })
}

test("three hundred unique reads compact despite absence of duplicate outputs", () => {
  const messages = source(300)
  const result = plan(messages)
  expect(result.compacted).toBe(true)
  expect(result.freedTokens).toBeGreaterThan(result.rawTokens * 0.5)
  expect(result.operations.length).toBeGreaterThan(200)
  expect(result.memory.every((entry: any) => entry.kind !== "constraints")).toBe(true)
  expect(result.budget.memoryTokens).toBeLessThanOrEqual(result.budget.historyBudgetTokens)
  const applied = pure.materializeCompaction(messages, result)
  expect(applied.status).toBe("applied")
  expect(applied.messages.slice(-10)).toEqual(messages.slice(-10))
  expect(applied.messages.filter((message) => message.info.role === "user")).toEqual(messages.filter((message) => message.info.role === "user"))
})

test("a protected island does not block later completed observations", () => {
  const messages = source(12)
  messages[3]!.protected = true
  messages[5]!.parts.push({ type: "tool", tool: "bash", state: { status: "running", output: "live output" } })
  const result = plan(messages)
  expect(result.replacedMessageIds).not.toContain("a1")
  expect(result.replacedMessageIds).toContain("a2")
  expect(result.replacedMessageIds).toContain("a6")
  const applied = pure.materializeCompaction(messages, result)
  expect(applied.status).toBe("applied")
  expect(applied.messages.find((message) => message.info.id === "a1")).toEqual(messages[3])
  expect(applied.messages.find((message) => message.info.id === "a2")!.parts[1]).toEqual(messages[5]!.parts[1])
})

test("identical tool arguments with changed output remain separate evidence", () => {
  const messages = source(8)
  for (const index of [1, 3, 5]) (messages[index]!.parts[0] as any).input = { path: "src/same.ts" }
  const result = plan(messages, { retainRecentTurns: 0 })
  expect(result.metrics.deduplicatedObservations).toBe(0)
  expect(result.nodes.flatMap((node: any) => node.sourceRefs).some((ref: any) => ref.messageId === "a0")).toBe(true)
  expect(result.nodes.flatMap((node: any) => node.sourceRefs).some((ref: any) => ref.messageId === "a1")).toBe(true)
  ;(messages[3]!.parts[0] as any).state.output = (messages[1]!.parts[0] as any).state.output
  expect(plan(messages, { retainRecentTurns: 0 }).metrics.deduplicatedObservations).toBe(1)
})

test("a retained analysis cache avoids repeating unchanged message analysis", () => {
  const createCache = (pure as Record<string, any>).createLayeredCache
  expect(typeof createCache).toBe("function")
  const cache = createCache({ maxEntries: 1_000 })
  const messages = source(40)
  const first = plan(messages, { cache })
  const second = plan(structuredClone(messages), { cache })
  expect(first.metrics.analyzedMessages).toBe(messages.length)
  expect(second.metrics.analyzedMessages).toBe(0)
  expect(second.metrics.analysisCacheHits).toBe(messages.length)
  expect(second.operations).toEqual(first.operations)
  const next = plan([...messages, ...source(1).map((message) => ({ ...message, info: { ...message.info, id: `new-${message.info.id}` } }))], { cache })
  expect(next.metrics.analyzedMessages).toBe(2)
})

test("verbatim constraints survive outside an exhausted memory budget", () => {
  const messages = source(8)
  const exact = "禁止改动认证与权限检查。金额不可四舍五入。Never log credentials.\n".repeat(200)
  messages[0]!.parts = [{ type: "text", text: exact }]
  const result = plan(messages, { contextWindowTokens: 1000, targetTokens: 550, memoryMaxTokens: 0 })
  expect(result.protectedMemory.some((entry: any) => entry.text === exact)).toBe(true)
  expect(result.budget.memoryTokens).toBe(0)
  expect(result.budgetExceeded).toBe(true)
  expect(result.budget.reasons).toContain("protected-content-exceeds-target")
  const applied = pure.materializeCompaction(messages, result)
  expect(applied.messages[0]!.parts).toEqual(messages[0]!.parts)
})

test("only clearly labeled reference materials are externalized without surrounding requirements", () => {
  const messages = source(8)
  const code = "export const code = 'many unique lines';\n".repeat(400)
  messages[0]!.parts = [{ type: "text", text: `Keep names unchanged.\nFile contents:\n\`\`\`ts\n${code}\`\`\`\nDo not change authentication.` }]
  messages[2]!.parts = [{ type: "text", text: `Implement the following code:\n\`\`\`ts\n${code}\`\`\`\nPreserve ordering.` }]
  const result = plan(messages)
  const applied = pure.materializeCompaction(messages, result)
  const output = (applied.messages[0]!.parts[0] as any).text
  expect(output).toContain("Keep names unchanged.")
  expect(output).toContain("Do not change authentication.")
  expect(output).not.toContain("export const code")
  expect(applied.messages[2]).toEqual(messages[2])
})

test("unresolved diagnostics outrank successful evidence and remain tied to command and version", () => {
  const messages = source(9)
  messages[1]!.parts = [{ type: "tool", tool: "bash", input: { command: "pnpm test auth.test.ts", revision: "before" }, state: { status: "error", output: "ordinary log\n".repeat(400) + "FAIL auth.test.ts\nExpected forbidden, received allowed\nAuthentication bypass at auth.ts:99", error: "exit code 1" } }]
  messages[3]!.parts = [{ type: "tool", tool: "bash", input: { command: "pnpm test other.test.ts", revision: "after" }, state: { status: "completed", output: "ordinary log\n".repeat(400) + "Tests 1 passed" } }]
  const result = plan(messages, { memoryMaxTokens: 150 })
  expect(result.memory[0].kind).toBe("failures")
  expect(result.memory[0].text).toContain("auth.test.ts")
  expect(result.memory[0].text).toContain("Expected forbidden, received allowed")
  expect(result.memory[0].sourceIds).toEqual(["a0"])
  const applied = pure.materializeCompaction(messages, result)
  expect((applied.messages[1]!.parts[0] as any).state.error).toBe("exit code 1")
})

test("zero-gain contexts bypass and invalid budgets fail explicitly", () => {
  const messages = source(8).map((message) => ({ ...message, parts: message.parts.map((part) => part.type === "tool" ? { ...part, state: { ...part.state, output: "ok" } } : part) }))
  const result = plan(messages)
  expect(result.compacted).toBe(false)
  expect(result.operations).toEqual([])
  expect(result.nodes).toEqual([])
  expect(result.freedTokens).toBe(0)
  expect(result.finalTokensEst).toBe(result.rawTokens)
  expect(() => plan(messages, { contextWindowTokens: -1 })).toThrow()
})

test("large single outputs are divided into approximately 8K-token source leaves", () => {
  const messages = source(8)
  ;(messages[1]!.parts[0] as any).state.output = "long source code line with identifier\n".repeat(5000)
  const result = plan(messages)
  const leaves = result.nodes.filter((node: any) => node.level === 0)
  expect(leaves.every((node: any) => node.sourceTokens <= 8192)).toBe(true)
  expect(leaves.filter((node: any) => node.sourceRefs.some((ref: any) => ref.messageId === "a0")).length).toBeGreaterThan(1)
})

test("immutable parent nodes retain recoverable ancestry across twenty planning generations", () => {
  let messages = source(20)
  const allNodes = new Map<string, any>()
  for (let generation = 0; generation < 20; generation++) {
    const result = plan(messages, { nodes: [...allNodes.values()], retainRecentTurns: 0, contextWindowTokens: 1000, targetTokens: 550 })
    expect(result.compacted).toBe(true)
    for (const node of result.nodes) {
      if (allNodes.has(node.nodeId)) expect(node).toEqual(allNodes.get(node.nodeId))
      allNodes.set(node.nodeId, node)
      expect(node.tokens).toBeLessThanOrEqual(node.level === 0 ? 512 : 1024)
      if (node.level > 0) expect(node.children.length).toBeGreaterThanOrEqual(4)
    }
    messages = pure.materializeCompaction(messages, result).messages
    messages.push(...source(4).map((message) => ({ ...message, info: { ...message.info, id: `g${generation}-${message.info.id}` } })))
  }
  const nodes = [...allNodes.values()]
  expect(nodes.some((node) => node.level >= 2)).toBe(true)
  const originalLeaf = nodes.find((node) => node.sourceRefs.some((ref: any) => ref.messageId === "a0"))
  expect(originalLeaf).toBeDefined()
  expect(nodes.some((node) => node.children.includes(originalLeaf.nodeId))).toBe(true)
  expect(nodes.every((node) => node.children.every((child: string) => allNodes.has(child)))).toBe(true)
})

test("zero memory allowance keeps mandatory failing diagnostic visible", () => {
  const messages = source(8)
  messages[1]!.parts = [{ type: "tool", tool: "bash", input: { command: "pnpm test auth.test.ts" }, state: { status: "error", output: "setup log\n".repeat(500) + "FAIL auth.test.ts\nExpected forbidden, received allowed" } }]
  const result = plan(messages, { memoryMaxTokens: 0 })
  expect(result.budget.memoryTokens).toBe(0)
  const visible = pure.materializeCompaction(messages, result).messages
  expect((visible[1]!.parts[0] as any).state.output).toContain("Expected forbidden, received allowed")
})

test("individual nonpositive-gain observations remain verbatim even when other operations save tokens", () => {
  const messages = source(8)
  messages[1]!.parts = [{ type: "tool", tool: "bash", input: { command: "pnpm test auth.test.ts", description: "long input must remain untouched ".repeat(50) }, state: { status: "error", output: "FAIL auth.test.ts: ".repeat(10) } }]
  const result = plan(messages)
  expect(result.compacted).toBe(true)
  expect(result.replacedMessageIds).not.toContain("a0")
  expect(pure.materializeCompaction(messages, result).messages[1]).toEqual(messages[1])
})

test("task state retains distinct command revisions and explicit unfinished work", () => {
  const messages = source(8)
  messages[1]!.parts.push({ type: "text", text: "TODO: fix the failing authorization test before release." })
  messages[3]!.parts = [{ type: "tool", tool: "bash", input: { command: "pnpm test other.test.ts", revision: "new" }, state: { status: "completed", output: "test setup\n".repeat(300) + "Tests 1 passed" } }]
  const result = plan(messages)
  expect(result.taskState?.events.some((event: any) => event.kind === "open" && event.text.includes("authorization"))).toBe(true)
  const verified = result.taskState.events.find((event: any) => event.kind === "verification")
  expect(verified.text).toContain("other.test.ts")
  expect(verified.sourceIds).toEqual(["a1"])
  expect(verified.inputDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(verified.outputDigest).toMatch(/^[0-9a-f]{64}$/)
})

test("a relaxed final target does not enlarge the 55-percent history-memory allowance", () => {
  const result = plan(source(8), { contextWindowTokens: 1000, targetTokens: 100_000 })
  expect(result.budget.historyBudgetTokens).toBe(0)
})

test("legacy archived constraints remain exact protected memory when entering layered mode", () => {
  const messages = source(8)
  messages[0] = { info: { id: `compaction-${"a".repeat(64)}`, role: "user" }, parts: [{ type: "text", text: "Old archival wrapper with summarized history." }], archive: { historyHash: "a".repeat(64), memory: [{ kind: "constraints", text: "Never alter the wire-level error code values.", sourceIds: ["original-requirement"] }] } }
  const result = plan(messages)
  expect(result.protectedMemory).toContainEqual({ kind: "constraints", text: "Never alter the wire-level error code values.", sourceIds: ["original-requirement"] })
})
