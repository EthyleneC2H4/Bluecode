import { expect, test } from "bun:test"
import type { ChatMessage, HeadroomCompressResult, ViewOperation } from "@bluecode/contracts"
import { materializeCompaction } from "../src/compaction"
import { createHash } from "node:crypto"
import { contentDigest } from "../src/turns"
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const messages: ChatMessage[] = [
  { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "Keep exact constraints." }] },
  { info: { id: "a", role: "assistant" }, parts: [{ type: "text", text: "prefix ABCD middle EFGH suffix" }, { type: "tool", tool: "read", state: { status: "completed", output: "original tool output" } }] },
  { info: { id: "island", role: "assistant" }, protected: true, parts: [{ type: "text", text: "protected" }] },
  { info: { id: "b", role: "assistant" }, parts: [{ type: "text", text: "old evidence" }] },
]
function base(operations: ViewOperation[]): HeadroomCompressResult {
  return {
    compacted: true, historyHash: digest("history"), summary: "bounded", refs: [], memory: [], replacedMessageIds: ["a", "b"],
    rawTokens: 100, summaryTokens: 10, sourceTokensEst: 100, evictedTokensEst: 50, retainedTokensEst: 50, replacementTokensEst: 10, finalTokensEst: 60, freedTokens: 40,
    operations, sourceSnapshot: { messageIds: messages.map((message) => message.info.id), sourceDigests: messages.map(contentDigest) },
  }
}
function ops(): ViewOperation[] {
  return [
    { kind: "text-range", sourceVersion: 1, operationId: digest("text"), nodeId: digest("node"), messageId: "a", sourceDigest: contentDigest(messages[1]!), partIndex: 0, start: 7, end: 11, textDigest: digest("ABCD"), replacement: "X" },
    { kind: "tool-output", sourceVersion: 1, operationId: digest("tool"), nodeId: digest("node"), messageId: "a", sourceDigest: contentDigest(messages[1]!), partIndex: 1, outputDigest: digest("original tool output"), replacement: "tool reference" },
    { kind: "range", sourceVersion: 1, operationId: digest("range"), nodeId: digest("node"), messageIds: ["b"], sourceDigests: [contentDigest(messages[3]!)], replacement: { info: { id: "replacement-b", role: "assistant" }, parts: [{ type: "text", text: "evidence reference" }] } },
  ]
}
test("disjoint partial and range operations apply atomically across a protected island", () => {
  const original = structuredClone(messages)
  const result = materializeCompaction(messages, base(ops()))
  expect(result.status).toBe("applied")
  expect(result.messages[1]!.parts).toEqual([{ type: "text", text: "prefix X middle EFGH suffix" }, { type: "tool", tool: "read", state: { status: "completed", output: "tool reference" } }])
  expect(result.messages[2]).toEqual(messages[2])
  expect(result.messages[3]!.info.id).toBe("replacement-b")
  expect(messages).toEqual(original)
  expect(materializeCompaction(structuredClone(messages), base(ops())).messages).toEqual(result.messages)
})
test("overlaps and invalid later operations reject the entire plan", () => {
  const overlapping = ops()
  overlapping.push({ ...overlapping[0]!, operationId: digest("overlap") } as ViewOperation)
  for (const operations of [overlapping, ops().map((op, index) => index === 2 ? { ...op, sourceDigests: [digest("wrong")] } : op) as ViewOperation[]]) {
    const result = materializeCompaction(messages, base(operations))
    expect(result.status).toBe("invalid")
    expect(result.messages).toEqual(messages)
  }
})
test("snapshot binding rejects moved islands and deleted unoperated constraints but allows appended turns", () => {
  for (const input of [messages.slice(1), [messages[0]!, messages[2]!, messages[1]!, messages[3]!]]) {
    expect(materializeCompaction(input, base(ops())).status).toBe("invalid")
  }
  const appended: ChatMessage = { info: { id: "next", role: "user" }, parts: [{ type: "text", text: "next task" }] }
  const result = materializeCompaction([...messages, appended], base(ops()))
  expect(result.status).toBe("applied")
  expect(result.messages.at(-1)).toEqual(appended)
})
test("legacy digest-bound single range plans remain replayable", () => {
  const { operations, sourceSnapshot, ...legacy } = base(ops())
  legacy.replacedMessageIds = ["b"]
  legacy.sourceDigests = [contentDigest(messages[3]!)]
  expect(materializeCompaction(messages, legacy).status).toBe("applied")
})

test("v3 operations reject a missing full snapshot even with valid individual digests", () => {
  const invalid = base(ops())
  delete invalid.sourceSnapshot
  expect(materializeCompaction(messages, invalid).status).toBe("invalid")
})
