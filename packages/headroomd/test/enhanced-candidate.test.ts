import { expect, test } from "bun:test"
import { buildLayeredPlan } from "../src/layered"
import { materializeCompaction } from "../src/compaction"
import { buildEnhancedCandidate } from "../src/enhanced-candidate"
import type { ChatMessage } from "@bluecode/contracts"

test("enhanced candidates preserve source bindings and require a net reduction within the rule memory budget", () => {
  const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => [
    { info: { id: `u${i}`, role: "user" as const }, parts: [{ type: "text" as const, text: "Keep the public API unchanged." }] },
    { info: { id: `a${i}`, role: "assistant" as const }, parts: [{ type: "tool" as const, tool: "read", input: { filePath: `src/${i}.ts` }, state: { status: "completed", output: Array.from({ length: 100 }, (_, line) => `export const value_${i}_${line} = ${line}`).join("\n") } }] },
  ]).flat()
  const base = buildLayeredPlan(messages, { namespace: { projectId: "p", sessionId: "s" }, contextWindowTokens: 32000 })
  const node = base.nodes.find((node) => node.level === 0 && node.sourceRefs.length > 1)!
  const entries = [{ kind: "decisions" as const, text: "Several source files were inspected.", sourceIds: node.sourceRefs.map((ref) => ref.messageId) }]
  const candidate = buildEnhancedCandidate(base, node, entries, messages, "test-model")
  expect(candidate).not.toBeNull()
  expect(candidate!.plan.finalTokensEst).toBeLessThan(base.finalTokensEst)
  expect(candidate!.plan.sourceSnapshot).toEqual(base.sourceSnapshot)
  expect(candidate!.plan.protectedMemory).toEqual(base.protectedMemory)
  expect(candidate!.plan.taskState).toEqual(base.taskState)
  expect(materializeCompaction(messages, candidate!.plan).status).toBe("applied")
  expect(buildEnhancedCandidate(base, node, [{ ...entries[0]!, sourceIds: ["forged"] }], messages, "test-model")).toBeNull()
  expect(buildEnhancedCandidate(base, node, [{ ...entries[0]!, text: "inflated".repeat(10000) }], messages, "test-model")).toBeNull()
  expect(buildEnhancedCandidate(base, node, [{ ...entries[0]!, kind: "constraints" }], messages, "test-model")).toBeNull()
})
