import { expect, test } from "bun:test"
import type { ChatMessage, LayeredNode, LayeredStateEvent, ViewOperation } from "@bluecode/contracts"
import { buildLayeredPlan, materializeCompaction, materializeOperations, contentDigest, textDigest, nodeContentHash } from "../src/pure"

const namespace = { projectId: "fix1-project", sessionId: "fix1-session" }
const options = { namespace, contextWindowTokens: 2000, targetTokens: 1100, retainRecentTurns: 0, memoryMaxTokens: 0 }
function generation(id: string): ChatMessage[] {
  return [
    { info: { id: `u-${id}`, role: "user" }, parts: [{ type: "text", text: "Keep all existing public APIs unchanged." }] },
    { info: { id: `write-${id}`, role: "assistant" }, parts: [{ type: "tool", tool: "write", input: { path: "src/auth.ts", revision: id }, state: { status: "completed", output: `Updated src/auth.ts version ${id}\n` + "file detail\n".repeat(800) } }] },
    { info: { id: `fail-${id}`, role: "assistant" }, parts: [{ type: "tool", tool: "bash", input: { command: "pnpm test auth.test.ts", revision: id }, state: { status: "error", output: "FAIL auth.test.ts\nExpected forbidden, received allowed\n" + "runner log\n".repeat(800) } }] },
  ]
}
function tail(): ChatMessage { return { info: { id: "active", role: "user" }, parts: [{ type: "text", text: "Continue." }] } }

test("long generic error metadata cannot evict the failing assertion from the visible skeleton", () => {
  const messages = [...generation("v0"), tail()]
  const tool = messages[2]!.parts[0]!
  if (tool.type !== "tool") throw new Error("fixture")
  tool.state.error = "generic runner context ".repeat(150)
  const result = buildLayeredPlan(messages, options)
  expect(result.compacted).toBe(true)
  const visible = materializeCompaction(messages, result).messages[2]!.parts[0]!
  if (visible.type !== "tool") throw new Error("tool removed")
  expect(visible.state.output).toContain("FAIL auth.test.ts")
  expect(visible.state.output).toContain("Expected forbidden, received allowed")
  expect(result.taskState.events.find((event) => event.sourceIds.includes("fail-v0"))!.text).toContain("Expected forbidden, received allowed")
  expect(visible.state.error).toBe(tool.state.error)
})

test("all twenty generations retain immutable original file versions and failure events with zero memory allowance", () => {
  let messages = [...generation("v0"), tail()]
  const nodes = new Map<string, LayeredNode>()
  const expected = new Map<string, LayeredStateEvent>()
  for (let iteration = 0; iteration < 20; iteration++) {
    const result = buildLayeredPlan(messages, { ...options, nodes: [...nodes.values()] })
    for (const [eventId, event] of expected) expect(result.taskState.events.find((item) => item.eventId === eventId)).toEqual(event)
    for (const event of result.taskState.events) expected.set(event.eventId, structuredClone(event))
    for (const node of result.nodes) nodes.set(node.nodeId, node)
    expect(result.budget.memoryTokens).toBe(0)
    expect(result.compacted).toBe(true)
    messages = materializeCompaction(messages, result).messages
    messages.splice(-1, 1, ...generation(`v${iteration + 1}`), tail())
  }
  const final = buildLayeredPlan(messages, { ...options, nodes: [...nodes.values()] })
  expect(final.taskState.events.filter((event) => event.kind === "changes")).toHaveLength(21)
  expect(final.taskState.events.filter((event) => event.kind === "failures")).toHaveLength(21)
  expect(new Set(final.taskState.events.map((event) => event.eventId)).size).toBe(final.taskState.events.length)
  expect(new Set(final.taskState.events.filter((event) => event.kind === "changes").map((event) => event.inputDigest)).size).toBe(21)
  expect(final.taskState.events.find((event) => event.sourceIds.includes("fail-v0"))).toMatchObject({ order: 2, sourceDigests: [contentDigest(generation("v0")[2]!)] })
})

test("a visible parent restores only reachable namespace-bound leaf state without copying ancestry into the parent", () => {
  const messages = [...Array.from({ length: 12 }, (_, i) => generation(`initial-${i}`)).flat(), tail()]
  const first = buildLayeredPlan(messages, options)
  const parent = first.nodes.filter((node) => node.level > 0).at(-1)!
  expect(parent).toBeDefined()
  const byId = new Map(first.nodes.map((node) => [node.nodeId, node]))
  const reachable = new Set<string>()
  const visit = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const child of byId.get(id)?.children ?? []) visit(child) }
  visit(parent.nodeId)
  const originalSourceIds = new Set([...reachable].flatMap((id) => byId.get(id)!.sourceRefs.map((ref) => ref.messageId)))
  const reference: ChatMessage = { info: { id: "parent-reference", role: "assistant" }, parts: [{ type: "text", text: `[headroom node:${parent.nodeId}]` }] }
  const next = buildLayeredPlan([reference, ...generation("new"), tail()], { ...options, nodes: first.nodes })
  const wanted = first.taskState.events.filter((event) => event.sourceIds.some((id) => originalSourceIds.has(id)))
  expect(wanted.length).toBeGreaterThan(0)
  for (const event of wanted) expect(next.taskState.events.find((item) => item.eventId === event.eventId)).toEqual(event)
  expect((parent as LayeredNode & { stateEvents?: LayeredStateEvent[] }).stateEvents).toBeUndefined()
  const foreign = buildLayeredPlan([reference, tail()], { ...options, namespace: { ...namespace, sessionId: "other" }, nodes: first.nodes })
  expect(foreign.taskState.events).toHaveLength(0)
  const tampered = first.nodes.map((node) => node.nodeId === parent.nodeId ? { ...node, children: [] } : node)
  expect(buildLayeredPlan([reference, tail()], { ...options, nodes: tampered }).taskState.events).toHaveLength(0)
})

test("pure materialization rejects source operations outside its validated snapshot prefix", () => {
  const messages = [...generation("v0"), tail()]
  const tool = messages[1]!.parts[0]!
  if (tool.type !== "tool") throw new Error("fixture")
  const base = { sourceVersion: 1 as const, operationId: textDigest("operation"), nodeId: textDigest("node") }
  const operation: ViewOperation = { ...base, kind: "tool-output", messageId: "write-v0", sourceDigest: contentDigest(messages[1]!), partIndex: 0, outputDigest: textDigest(tool.state.output!), replacement: "reference" }
  const partial = { messageIds: [messages[0]!.info.id], sourceDigests: [contentDigest(messages[0]!)] }
  for (const snapshot of [{ messageIds: [], sourceDigests: [] }, partial]) {
    const result = materializeOperations(messages, [operation], snapshot)
    expect(result.status).toBe("invalid")
    expect(result.messages).toEqual(messages)
  }
  const range: ViewOperation = { ...base, kind: "range", messageIds: [messages[0]!.info.id, messages[1]!.info.id], sourceDigests: [contentDigest(messages[0]!), contentDigest(messages[1]!)], replacement: { info: { id: "replacement", role: "assistant" }, parts: [{ type: "text", text: "reference" }] } }
  expect(materializeOperations(messages, [range], partial).status).toBe("invalid")
})

test("an assertion too large for the diagnostic allowance keeps its original output", () => {
  const messages = [...generation("v0"), tail()]
  const tool = messages[2]!.parts[0]!
  if (tool.type !== "tool") throw new Error("fixture")
  tool.state.output = "FAIL auth.test.ts\nExpected forbidden, received " + "critical assertion detail ".repeat(300) + "\n" + "runner log\n".repeat(800)
  const result = buildLayeredPlan(messages, options)
  expect(result.compacted).toBe(true)
  expect(result.replacedMessageIds).not.toContain("fail-v0")
  expect(materializeCompaction(messages, result).messages[2]).toEqual(messages[2])
})

test("leaf state metadata is bounded and rejects events unrelated to its immutable sources", async () => {
  const { layeredNodeSchema } = await import("@bluecode/contracts")
  const messages = [...generation("v0"), tail()]
  const result = buildLayeredPlan(messages, options)
  const leaf = result.nodes.find((node) => node.level === 0 && node.stateEvents?.length)!
  expect(layeredNodeSchema.safeParse(leaf).success).toBe(true)
  const unrelated = { ...leaf, stateEvents: leaf.stateEvents!.map((event) => ({ ...event, sourceDigests: [textDigest("foreign source")] })) }
  expect(layeredNodeSchema.safeParse(unrelated).success).toBe(false)
  const { nodeId, ...content } = unrelated
  const forged = { ...content, nodeId: nodeContentHash(content) }
  const reference: ChatMessage = { info: { id: "forged-reference", role: "assistant" }, parts: [{ type: "text", text: `[headroom node:${forged.nodeId}]` }] }
  expect(buildLayeredPlan([reference, tail()], { ...options, nodes: [forged] }).taskState.events).toHaveLength(0)
  expect(layeredNodeSchema.safeParse({ ...leaf, stateEvents: Array.from({ length: 65 }, () => leaf.stateEvents![0]!) }).success).toBe(false)
})
