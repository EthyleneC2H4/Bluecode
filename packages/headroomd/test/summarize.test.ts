import { describe, expect, test } from "bun:test"
import {
  firstSentence,
  historySummary,
  keywords,
  messageExcerpt,
  messageSummary,
  turnSummary,
} from "../src/summarize"
import { splitTurns } from "../src/turns"
import type { ChatMessage } from "@bluecode/contracts"

function user(id: string, text: string): ChatMessage {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] }
}
function assistant(id: string, text: string): ChatMessage {
  return { info: { id, role: "assistant" }, parts: [{ type: "text", text }] }
}

describe("firstSentence", () => {
  test("splits on CJK and ASCII terminators and newlines", () => {
    expect(firstSentence("修复登录bug。然后重构。")).toBe("修复登录bug。")
    expect(firstSentence("Fix the bug. Then refactor.")).toBe("Fix the bug.")
    expect(firstSentence("line one\nline two")).toBe("line one")
    expect(firstSentence("  spaced out  ")).toBe("spaced out")
    expect(firstSentence("")).toBe("")
  })

  test("caps length deterministically", () => {
    const long = "x".repeat(500)
    const out = firstSentence(long)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("turnSummary", () => {
  test("three segments: intent | action | tool anchors", () => {
    const turn = splitTurns([
      user("u1", "跑一下测试看看哪些挂了"),
      assistant("a1", "我来运行测试套件。"),
      assistant("a2", "分析失败原因中。"),
      assistant("a3", "第三个要点。"),
      assistant("a4", "第四条不该出现（超过3条上限）。"),
      {
        info: { id: "t1", role: "assistant" },
        parts: [
          { type: "tool", tool: "bash", state: { status: "ok", output: "\nFAIL auth.test.ts\n" } },
        ],
      },
    ])[0]!
    const summary = turnSummary(turn)
    expect(summary).toContain("intent: 跑一下测试看看哪些挂了")
    expect(summary).toContain("action: 我来运行测试套件。")
    expect(summary.match(/action:/g)?.length).toBe(3)
    expect(summary).toContain("tool bash: FAIL auth.test.ts")
    expect(summary).not.toContain("第四条")
  })

  test("empty turn yields empty summary (deterministic)", () => {
    const turn = splitTurns([assistant("a1", "")])[0]!
    expect(turnSummary(turn)).toBe("")
  })
})

describe("historySummary", () => {
  test(">12 turns preserves evidence from every turn", () => {
    const messages: ChatMessage[] = []
    for (let i = 0; i < 15; i++) {
      messages.push(user(`u${i}`, `turn number ${i} question`))
      messages.push(assistant(`a${i}`, `turn number ${i} answer`))
    }
    const turns = splitTurns(messages)
    const summary = historySummary(turns)
    expect(summary).toContain("[u0]")
    expect(summary).toContain("[u1]")
    expect(summary).toContain("[u14]")
    expect(summary).toContain("[u7]")
    // elided range is T2..T6; the tail window starts at T7
    expect(summary).toContain("[u4]")
    // deterministic: identical across runs
    expect(historySummary(turns)).toBe(summary)
  })

  test("≤12 turns keeps everything", () => {
    const turns = splitTurns([user("u0", "q0"), user("u1", "q1")])
    const summary = historySummary(turns)
    expect(summary).toContain("[u0]")
    expect(summary).toContain("[u1]")
    expect(summary).not.toContain("…")
  })
})

describe("messageSummary / messageExcerpt / keywords", () => {
  test("messageSummary is role-tagged and single-line-ish", () => {
    expect(messageSummary(user("u1", "查询数据库状态。"))).toContain("user:")
    expect(messageSummary(assistant("a1", "执行了迁移。"))).toContain("assistant:")
  })

  test("excerpt preserves full text for indexing", () => {
    const excerpt = messageExcerpt(user("u1", "y".repeat(400)))
    expect(excerpt).toBe("y".repeat(400))
  })

  test("keywords: top-8, stopword-free, deterministic order", () => {
    const text =
      "压缩 压缩 压缩 检索 检索 历史 the and 历史 工具 工具 工具 工具 配置 配置 索引 缓存"
    const kw = keywords(text)
    expect(kw.split(" ").length).toBeLessThanOrEqual(8)
    expect(kw).not.toContain("the ")
    expect(keywords(text)).toBe(kw) // deterministic
    expect(keywords("")).toBe("")
  })
})
