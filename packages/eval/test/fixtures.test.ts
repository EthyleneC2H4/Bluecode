/**
 * Fixture determinism and golden-facts coverage.
 *
 * Brief requirement #1: two builds must be byte-for-byte identical; golden
 * facts must be present in the expected counts. NOT covered here: full
 * four-group scoring (that is cli's job).
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  buildFixtures,
  allFixtures,
  quickFixtures,
  fixturesToHeadroomParams,
} from "../src/fixtures"

describe("fixtures: determinism", () => {
  test("two consecutive builds are byte-for-byte identical", () => {
    const a = JSON.stringify(buildFixtures())
    const b = JSON.stringify(buildFixtures())
    expect(a).toBe(b)
  })

  test("allFixtures() is also stable across calls", () => {
    expect(JSON.stringify(allFixtures())).toBe(JSON.stringify(allFixtures()))
  })

  test("quickFixtures() is a strict subset shape of allFixtures()", () => {
    const quick = quickFixtures()
    const all = allFixtures()
    expect(quick.length).toBeLessThan(all.length)
    // Each quick fixture's name must exist in the full set (bun's toContain
    // uses reference equality for objects, so compare by name).
    const names = all.map((f) => f.name)
    for (const q of quick) {
      expect(names).toContain(q.name)
      // And determinism means an equal-name rebuild has equal content.
      const twin = all.find((f) => f.name === q.name)!
      expect(JSON.stringify(twin)).toBe(JSON.stringify(q))
    }
  })

  test("cross-run determinism is pinned by a content digest", () => {
    // Within one process both builds share TOOL_OUTPUT_POOL (evaluated once
    // at import), so the byte-equality tests above pass even if a generator
    // secretly used Math.random. This digest pins the exact bytes across
    // processes — update it deliberately alongside intentional content
    // changes only.
    const digest = createHash("sha256").update(JSON.stringify(allFixtures())).digest("hex")
    expect(digest).toBe("0f057f979461dc8f87789102f39e718131c5fba93858ecff05c63e1089f0c9b5")
  })
})

describe("fixtures: structure and golden facts", () => {
  const all = allFixtures()

  test("long session has >= 50 turns (one message per turn => >= 50 messages)", () => {
    const long = buildFixtures().longSession
    expect(long.messages.length).toBeGreaterThanOrEqual(50)
  })

  test("every fixture carries at least one must-hit golden fact", () => {
    for (const f of all) {
      expect(f.goldenFacts.mustHit.length).toBeGreaterThanOrEqual(1)
    }
  })

  test("tool-output pool covers the brief's required variants", () => {
    const descriptions = all.map((f) => f.description.toLowerCase()).join("\n")
    // ls -la / grep / read-with-line-numbers / git diff / test runner / noise,
    // plus ANSI \r \b pollution variants.
    for (const keyword of [
      "ls",
      "grep",
      "read",
      "diff",
      "test",
      "noise",
      "ansi",
      "carriage",
      "backspace",
    ]) {
      expect(descriptions).toContain(keyword)
    }
  })

  test("golden facts actually appear in their fixture's own content (self-consistency)", () => {
    // A must-hit fact that never existed in the source would make recall
    // testing meaningless — verify embedding at the source level.
    for (const f of all) {
      for (const part of f.messages.flatMap((m) => m.parts)) {
        if (part.type === "text") {
          // Text parts may reference facts; tool outputs embed them directly.
        }
      }
      const embedded = f.messages
        .flatMap((m) => m.parts)
        .map((p) => (p.type === "text" ? p.text : p.type === "tool" ? p.state.output ?? "" : ""))
        .join("\n")
      for (const fact of f.goldenFacts.mustHit) {
        expect(embedded.includes(fact)).toBe(true)
      }
    }
  })

  test("fixturesToHeadroomParams projects the documented namespace and defaults", () => {
    const f = all[0]!
    const params = fixturesToHeadroomParams(f)
    expect(params.sessionId).toBe(`eval-${f.name}`)
    expect(params.projectId).toBe("default")
    expect(params.contextWindowTokens).toBe(8192)
    expect(params.triggerRatio).toBe(0.7)
    expect(params.retainRecentTurns).toBe(4)
    expect(params.messages).toBe(f.messages)
  })
})

test("engineering replay questions are independent of expected answer identifiers", () => {
  const fixture = allFixtures().find((f) => f.name === "engineering-replay")!
  expect(fixture).toBeDefined()
  expect(fixture.questions?.length).toBeGreaterThanOrEqual(10)
  const raw = JSON.stringify(fixture.messages)
  for (const question of fixture.questions!) {
    for (const answer of question.expected) {
      expect(question.query.toLowerCase()).not.toContain(answer.toLowerCase())
      expect(raw).toContain(answer)
    }
  }
})
