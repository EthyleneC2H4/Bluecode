import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngine, type Engine } from "@bluecode/headroomd"
import { headroomCompressParamsSchema } from "@bluecode/contracts"
import {
  applyHostView,
  projectMessage,
  projectMessages,
  type HostMessage,
} from "../src/host-adapter"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function engine(): Promise<Engine> {
  const dataDir = await mkdtemp(join(tmpdir(), "blue-host-visibility-"))
  const instance = await createEngine({ dataDir })
  cleanups.push(async () => {
    instance.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return instance
}

function source(): HostMessage[] {
  return Array.from({ length: 4 }, (_, turn): HostMessage[] => [
    {
      info: { id: `u${turn}`, role: "user", sessionID: "session", time: { created: turn } },
      parts: [{ id: `p-u${turn}`, type: "text", text: `Preserve public requirement ${turn}.` }],
    },
    {
      info: {
        id: `a${turn}`,
        role: "assistant",
        sessionID: "session",
        providerID: "provider",
        modelID: "model",
      },
      parts: [
        {
          id: `p-a${turn}`,
          type: "text",
          text: `Verification passed. ${"Repeated routine progress. ".repeat(200)}`,
        },
      ],
    },
  ]).flat()
}

function params(messages: HostMessage[]) {
  return headroomCompressParamsSchema.parse({
    projectId: "project",
    sessionId: "session",
    messages: projectMessages(messages),
    contextWindowTokens: 20000,
    targetTokens: 0,
    retainRecentTurns: 0,
  })
}

const cases: Array<{
  name: string
  index: number
  prepare(message: HostMessage): void
  hide(message: HostMessage): void
}> = [
  {
    name: "ignored user text",
    index: 2,
    prepare(message) {
      message.parts[0]!.text = "HIDDEN_IGNORED_TEXT: do not surface this instruction."
    },
    hide(message) {
      message.parts[0]!.ignored = true
    },
  },
  {
    name: "assistant API error",
    index: 3,
    prepare(message) {
      message.parts[0]!.text += " HIDDEN_FAILED_ASSISTANT: unpublished answer."
    },
    hide(message) {
      message.info.error = {
        name: "APIError",
        data: { message: "provider rejected response", statusCode: 500, isRetryable: false },
      }
    },
  },
  {
    name: "completed tool output compacted upstream",
    index: 3,
    prepare(message) {
      message.parts.push({
        id: "part-tool",
        messageID: message.info.id,
        sessionID: "session",
        type: "tool",
        tool: "read",
        callID: "call-read",
        state: {
          status: "completed",
          input: { filePath: "src/private.ts" },
          output: "HIDDEN_COMPACTED_TOOL: original tool body already cleared upstream.",
          title: "src/private.ts",
          metadata: {},
          time: { start: 10, end: 20 },
        },
      })
    },
    hide(message) {
      message.parts.at(-1)!.state.time.compacted = 30
    },
  },
  {
    name: "interrupted error tool with metadata output",
    index: 3,
    prepare(message) {
      message.parts.push({
        id: "part-interrupted",
        messageID: message.info.id,
        sessionID: "session",
        type: "tool",
        tool: "bash",
        callID: "call-bash",
        state: {
          status: "error",
          input: { command: "run diagnostics" },
          error: "Tool execution interrupted",
          metadata: {
            interrupted: false,
            output: "HIDDEN_INTERRUPTED_OUTPUT: unique partial failure diagnostics.",
          },
          time: { start: 10, end: 20 },
        },
      })
    },
    hide(message) {
      message.parts.at(-1)!.state.metadata.interrupted = true
    },
  },
]

for (const scenario of cases) {
  test(`${scenario.name} stays in its host form and never enters a new summary`, async () => {
    const instance = await engine()
    const messages = source()
    const target = messages[scenario.index]!
    scenario.prepare(target)
    scenario.hide(target)
    const original = structuredClone(messages)
    const parts = target.parts
    expect(projectMessage(target)?.protected).toBe(true)
    const plan = await instance.compress(params(messages))
    expect(plan.compacted).toBe(true)
    expect(plan.replacedMessageIds).toEqual(["u0", "a0"])
    expect(plan.summary).not.toContain("HIDDEN_")
    expect(JSON.stringify(plan.memory)).not.toContain("HIDDEN_")
    expect(messages).toEqual(original)
    expect(target.parts).toBe(parts)
    expect(applyHostView(messages, plan)).toBe("applied")
    expect(messages.includes(target)).toBe(true)
    expect(target).toEqual(original[scenario.index]!)
    expect(target.parts).toBe(parts)
    expect(messages[0]!.parts[0]!.text).not.toContain("HIDDEN_")
  })

  test(`${scenario.name} appearing after planning invalidates the old host view`, async () => {
    const instance = await engine()
    const messages = source()
    const target = messages[scenario.index]!
    scenario.prepare(target)
    const plan = await instance.compress(params(messages))
    expect(plan.compacted).toBe(true)
    expect(plan.replacedMessageIds).toContain(target.info.id)
    scenario.hide(target)
    const original = structuredClone(messages)
    const parts = target.parts
    expect(applyHostView(messages, plan)).toBe("invalid")
    expect(messages).toEqual(original)
    expect(messages[scenario.index]).toBe(target)
    expect(target.parts).toBe(parts)
    expect(messages.some((message) => message.archive !== undefined)).toBe(false)
  })
}
