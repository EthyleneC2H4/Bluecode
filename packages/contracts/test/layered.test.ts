import { expect, test } from "bun:test"
import { headroomCompressParamsSchema, headroomCompressResultSchema, headroomRequestSchema, getCandidateParamsSchema, getCandidateResultSchema, headroomRetrieveParamsSchema, retrieveByNodeResultSchema, viewOperationSchema } from "../src/headroom"
const hash = "a".repeat(64), ns = { projectId: "p", sessionId: "s" }
const legacy = { compacted: true, historyHash: hash, summary: "summary", memory: [], refs: [{ contentHash: hash, role: "assistant", turnIndex: 0 }], replacedMessageIds: ["a"], sourceDigests: [hash], rawTokens: 100, sourceTokensEst: 100, summaryTokens: 20, evictedTokensEst: 50, retainedTokensEst: 50, replacementTokensEst: 20, finalTokensEst: 70, freedTokens: 30 }
const operation = { operationId: hash, sourceVersion: 1, nodeId: hash, kind: "tool-output", messageId: "a", sourceDigest: hash, partIndex: 0, outputDigest: hash, replacement: "reference" }

test("v3 accepts legacy omissions and optional layered configuration", () => {
  expect(headroomCompressResultSchema.safeParse(legacy).success).toBe(true)
  const parsed = headroomCompressParamsSchema.parse({ ...ns, messages: [], contextWindowTokens: 1000 })
  expect(parsed.strategy).toBeUndefined()
  expect(headroomRequestSchema.safeParse({ v: 3, id: "c", op: "getCandidate", params: {} }).success).toBe(true)
  expect(headroomRequestSchema.safeParse({ v: 2, id: "c", op: "compress", params: {} }).success).toBe(false)
})
test("operation plans require complete source snapshots and aligned affected sources", () => {
  expect(headroomCompressResultSchema.safeParse({ ...legacy, operations: [operation] }).success).toBe(false)
  const valid = { ...legacy, operations: [operation], sourceSnapshot: { messageIds: ["a"], sourceDigests: [hash] } }
  expect(headroomCompressResultSchema.safeParse(valid).success).toBe(true)
  expect(headroomCompressResultSchema.safeParse({ ...valid, operations: [{ ...operation, messageId: "different" }] }).success).toBe(false)
  expect(headroomCompressResultSchema.safeParse({ ...valid, operations: [operation, operation] }).success).toBe(false)
  expect(viewOperationSchema.safeParse({ ...operation, kind: "text-range", start: 5, end: 2, textDigest: hash }).success).toBe(false)
})
test("candidate ownership and bounded node response shapes survive protocol roundtrip", () => {
  expect(getCandidateParamsSchema.safeParse({ namespace: ns }).success).toBe(false)
  expect(getCandidateParamsSchema.parse({ namespace: ns, jobId: "job" }).jobId).toBe("job")
  expect(getCandidateResultSchema.parse({ status: "missing", candidate: null }).status).toBe("missing")
  expect(headroomRetrieveParamsSchema.safeParse({ namespace: ns, nodeId: hash, detail: "children", depth: 2 }).success).toBe(true)
  expect(headroomRetrieveParamsSchema.safeParse({ namespace: ns, nodeId: hash, hash }).success).toBe(false)
  const node = { nodeId: hash, level: 0, policyVersion: "v1", tokens: 10, sourceTokens: 100 }
  expect(retrieveByNodeResultSchema.safeParse({ found: true, node, content: "snippet", truncated: true, nextCursor: "opaque" }).success).toBe(true)
})
