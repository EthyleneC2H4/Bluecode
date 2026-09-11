import { expect, test } from "bun:test"
import { headroomFixtures, makeHeadroomFixture } from "../src/headroom-fixtures"

test("Dedicated histories cover eight distinct workloads at 50, 200 and 1000 complete turns", () => {
  const fixtures = headroomFixtures()
  expect(fixtures).toHaveLength(24)
  expect(new Set(fixtures.map((f) => f.name)).size).toBe(24)
  for (const fixture of fixtures) {
    expect(fixture.messages).toHaveLength(fixture.turns * 2)
    expect(fixture.messages.filter((m) => m.info.role === "user")).toHaveLength(fixture.turns)
  }
  const unique = makeHeadroomFixture("unique-code", 50)
  const outputs = unique.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool").map((p) => p.state.output))
  expect(new Set(outputs).size).toBe(50)
  const repeated = makeHeadroomFixture("repeated-output", 50)
  expect(new Set(repeated.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool").map((p) => p.state.output))).size).toBe(1)
})

test("Protected fixtures include host-native attachments and a pending tool amid later safe evidence", () => {
  const fixture = makeHeadroomFixture("protected-islands", 50)
  expect(fixture.protectedMessageIds.length).toBeGreaterThan(0)
  expect(fixture.messages.some((m) => m.parts.some((p) => p.type === "file"))).toBe(true)
  expect(fixture.messages.some((m) => m.parts.some((p) => p.state?.status === "running"))).toBe(true)
  expect(fixture.messages.at(-3)!.parts.some((p) => p.state?.status === "completed")).toBe(true)
})

test("Existing engineering replay adapter keeps the original active request and all ten independent questions", async () => {
  const { engineeringHeadroomFixture } = await import("../src/headroom-fixtures")
  const { allFixtures } = await import("../src/fixtures")
  const source = allFixtures().find((fixture) => fixture.name === "engineering-replay")!
  const adapted = engineeringHeadroomFixture()
  expect(adapted.messages.map((message) => message.parts)).toEqual(source.messages.map((message) => message.parts))
  expect(adapted.messages.at(-1)!.info.id).toBe("engineering-active")
  expect(adapted.questions).toEqual(source.questions)
  expect(adapted.questions).toHaveLength(10)
})
