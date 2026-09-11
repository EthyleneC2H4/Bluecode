import { allFixtures, type FixtureSample } from "./fixtures"
import type { PluginRuntime } from "@bluecode/plugin/runtime"
export type HeadroomHostMessage = Parameters<PluginRuntime["transform"]>[0]["messages"][number]
export const HEADROOM_SCENARIOS = ["unique-code", "repeated-output", "failure-repair", "requirement-correction", "multi-file", "user-material", "protected-islands", "multi-generation"] as const
export type HeadroomScenario = typeof HEADROOM_SCENARIOS[number]
export interface HeadroomFixture {
  name: string
  scenario: HeadroomScenario | "engineering-replay"
  turns: number
  messages: HeadroomHostMessage[]
  constraints: string[]
  protectedMessageIds: string[]
  query: string
  questions?: NonNullable<FixtureSample["questions"]>
  evidence: string
  /** Independent original message selected before compression, never a generated summary. */
  evidenceMessageId: string
}

/** Deterministic synthetic engineering histories, not claimed production traffic. */
export function makeHeadroomFixture(scenario: HeadroomScenario, turns: number): HeadroomFixture {
  if (!Number.isSafeInteger(turns) || turns < 10) throw new Error("turns must be an integer >= 10")
  const name = `${scenario}-${turns}`, messages: HeadroomHostMessage[] = [], protectedMessageIds: string[] = []
  const constraints = ["Preserve public API compatibility. Do not delete user data."]
  if (scenario === "requirement-correction") constraints.push("Correction: use cursor pagination; do not implement offset pagination.")
  if (scenario === "user-material") constraints.push("Keep the retry limit at 3 and preserve the error code.")
  const evidence = "ORIGINAL_REVISION_ZERO_SENTINEL"
  for (let turn = 0; turn < turns; turn++) {
    const file = scenario === "multi-file" ? `src/module-${turn % 12}.ts` : scenario === "multi-generation" ? "src/session-state.ts" : `src/feature-${turn}.ts`
    let request = turn === 0 ? constraints[0]! : `Continue inspection ${turn}.`
    if (scenario === "requirement-correction" && turn === 1) request = "Initially requested offset pagination."
    if (scenario === "requirement-correction" && turn === 2) request = constraints[1]!
    const lines = Array.from({ length: 48 }, (_, line) => `export const item_${turn}_${line} = { revision: ${turn}, key: "value-${line}", enabled: true }`).join("\n")
    let output = `File ${file}\n${turn === 0 ? evidence : `REVISION_${turn}`}\n${lines}`
    let tool = "read", input: Record<string, unknown> = { path: file }, status = "completed"
    if (scenario === "multi-generation") input.revision = turn
    if (scenario === "repeated-output") {
      output = `File src/shared.ts\n${evidence}\n` + Array.from({ length: 48 }, (_, i) => `export const shared_${i} = "stable invariant value ${i}"`).join("\n")
      input = { path: "src/shared.ts" }
    }
    if (scenario === "failure-repair") {
      tool = "bash"; input = { command: turn % 2 === 0 ? "bun test auth.test.ts" : "bun test unrelated.test.ts" }
      status = turn % 2 === 0 ? "error" : "completed"
      output = `${turn === 0 ? evidence + "\n" : ""}${turn % 2 === 0 ? "FAIL auth.test.ts\nExpected 403, received 200; authorization bug remains" : "PASS unrelated.test.ts: 3 tests passed"}\n` + lines
    }
    const user: HeadroomHostMessage = { info: { id: `${name}:u${turn}`, role: "user", sessionID: name }, parts: [{ type: "text", text: request }] }
    const assistant: HeadroomHostMessage = { info: { id: `${name}:a${turn}`, role: "assistant", sessionID: name }, parts: [{ type: "tool", tool, callID: `call-${turn}`, state: { status, input, output } }] }
    if (scenario === "user-material") {
      user.parts[0]!.text = `${request}\n${constraints[1]}\nReference material:\n\`\`\`typescript\n${output}\n\`\`\`\nPreserve the surrounding requirements verbatim.`
      assistant.parts = [{ type: "text", text: `Inspected supplied material ${turn}.` }]
    }
    if (scenario === "protected-islands") {
      if (turn === 2) assistant.parts.push({ type: "file", url: "file:///fixture/design.png", mime: "image/png", filename: "design.png" })
      if (turn === 3) assistant.parts[0]!.state.status = "running"
      if (turn === 4) assistant.parts.push({ type: "future-host-part", opaque: { retain: "exact bytes" } })
      if ([2, 3, 4].includes(turn)) protectedMessageIds.push(assistant.info.id)
    }
    messages.push(user, assistant)
  }
  return { name, scenario, turns, messages, constraints, protectedMessageIds,
    query: scenario === "failure-repair" ? "authorization bug" : scenario === "repeated-output" ? "shared.ts" : scenario === "multi-file" ? "module-0.ts" : scenario === "multi-generation" ? "session-state.ts" : "feature-0.ts",
    evidence, evidenceMessageId: `${name}:${scenario === "user-material" ? "u" : "a"}0` }
}
export function headroomFixtures(): HeadroomFixture[] {
  return HEADROOM_SCENARIOS.flatMap((scenario) => [50, 200, 1000].map((turns) => makeHeadroomFixture(scenario, turns)))
}

/** Reuses the existing benchmark verbatim; only attaches the host session identity. */
export function engineeringHeadroomFixture(): HeadroomFixture {
  const fixture = allFixtures().find((item) => item.name === "engineering-replay")!
  const evidence = fixture.goldenFacts.mustHit[0]!
  const source = fixture.messages.find((message) => JSON.stringify(message.parts).includes(evidence))!
  return {
    name: fixture.name, scenario: "engineering-replay", turns: 18,
    messages: fixture.messages.map((message) => ({ ...structuredClone(message), info: { ...message.info, sessionID: fixture.name } })),
    constraints: fixture.criticalFacts ?? [], protectedMessageIds: ["engineering-active"],
    query: fixture.questions![0]!.query, questions: structuredClone(fixture.questions!), evidence, evidenceMessageId: source.info.id,
  }
}
