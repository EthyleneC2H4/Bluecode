import { describe, expect, test } from "bun:test"
import { createLineReconstructor, encodeFrame, FrameOverflowError } from "../src/jsonl"

test("valid frames preceding overflow survive every chunk partition", () => {
  const stream = "one\n二\n" + "x".repeat(9)
  for (let split = 0; split <= stream.length; split++) {
    const parser = createLineReconstructor({ maxFrameBytes: 8 })
    const observed: string[] = []
    let overflow = false
    for (const chunk of [stream.slice(0, split), stream.slice(split)]) {
      try {
        observed.push(...parser.push(chunk))
      } catch (error) {
        expect(error).toBeInstanceOf(FrameOverflowError)
        observed.push(...((error as any).completedLines ?? []))
        overflow = true
        break
      }
    }
    expect(overflow).toBe(true)
    expect(observed).toEqual(["one", "二"])
  }
})

/** Fixed-seed LCG (Numerical Recipes constants) — reproducible, no Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const SAMPLE_STRINGS = [
  "",
  "plain ascii",
  "contains\nescaped newline",
  'quote " inside',
  "back\\slash \\",
  "中文文本與全形標點！？",
  "\t tabs \t",
  "{}{}",
  "trailing spaces   ",
  "emoji 👍🚀",
]

function randomValue(rand: () => number, depth: number): unknown {
  const roll = rand()
  if (depth <= 0 || roll < 0.45) {
    if (roll < 0.1) return Math.floor(rand() * 1000)
    if (roll < 0.18) return rand() > 0.5
    if (roll < 0.22) return null
    return SAMPLE_STRINGS[Math.floor(rand() * SAMPLE_STRINGS.length)]
  }
  if (roll < 0.72) {
    const obj: Record<string, unknown> = {}
    const n = 1 + Math.floor(rand() * 4)
    for (let i = 0; i < n; i++) {
      obj[`k${i}_${Math.floor(rand() * 100)}`] = randomValue(rand, depth - 1)
    }
    return obj
  }
  const arr: unknown[] = []
  const n = 1 + Math.floor(rand() * 4)
  for (let i = 0; i < n; i++) arr.push(randomValue(rand, depth - 1))
  return arr
}

/** Split input into exactly `pieces` chunks at uniformly random cut points. */
function splitRandom(input: string, pieces: number, rand: () => number): string[] {
  const cuts = new Set<number>()
  while (cuts.size < pieces - 1) cuts.add(Math.floor(rand() * (input.length + 1)))
  const sorted = [...cuts].sort((a, b) => a - b)
  const parts: string[] = []
  let prev = 0
  for (const cut of sorted) {
    parts.push(input.slice(prev, cut))
    prev = cut
  }
  parts.push(input.slice(prev))
  return parts
}

describe("jsonl framing", () => {
  test("encodeFrame appends LF", () => {
    expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n')
    expect(encodeFrame("x")).toBe('"x"\n')
  })

  test("fuzz: fixed-seed LCG, 120 samples, random chunking reconstructs byte-exactly", () => {
    const rand = lcg(20260823)
    for (let sample = 0; sample < 120; sample++) {
      const frames: unknown[] = []
      const frameCount = 1 + Math.floor(rand() * 10)
      for (let i = 0; i < frameCount; i++) {
        frames.push({
          v: 1,
          id: `r_${sample}_${i}`,
          payload: randomValue(rand, 3),
        })
      }
      const stream = frames.map((f) => encodeFrame(f)).join("")

      const pieceCount = 3 + Math.floor(rand() * 6) // 3-8 pieces
      const pieces = splitRandom(stream, pieceCount, rand)

      const rec = createLineReconstructor()
      const lines: string[] = []
      for (const piece of pieces) lines.push(...rec.push(piece))
      // every frame ended with LF -> nothing may remain
      expect(rec.flush()).toEqual([])

      const rebuilt = lines.map((line) => `${line}\n`).join("")
      expect(rebuilt).toBe(stream)
      expect(lines.map((line) => JSON.parse(line))).toEqual(frames)
    }
  })

  test("empty input produces no lines", () => {
    const rec = createLineReconstructor()
    expect(rec.push("")).toEqual([])
    expect(rec.flush()).toEqual([])
  })

  test("consecutive blank frames survive", () => {
    const rec = createLineReconstructor()
    expect(rec.push("\n\n")).toEqual(["", ""])
    expect(rec.push("{}\n\n{}\n")).toEqual(["{}", "", "{}"])
  })

  test("single 1MB line survives heavy chunking", () => {
    const blob = "x".repeat(1024 * 1024)
    const stream = encodeFrame({ blob })
    const rec = createLineReconstructor()
    const lines: string[] = []
    for (let i = 0; i < stream.length; i += 997) {
      lines.push(...rec.push(stream.slice(i, i + 997)))
    }
    expect(rec.flush()).toEqual([])
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "").blob).toBe(blob)
  })

  test("CRLF tolerated and stripped; lone CR preserved", () => {
    let rec = createLineReconstructor()
    expect(rec.push("a\r\nb\r\n")).toEqual(["a", "b"])
    rec = createLineReconstructor()
    expect(rec.push("x\r\ny\nz\r\n")).toEqual(["x", "y", "z"])
    rec = createLineReconstructor()
    expect(rec.push("a\rb\n")).toEqual(["a\rb"])
  })

  test("flush returns residual half-line exactly once, then empty", () => {
    const rec = createLineReconstructor()
    expect(rec.push('{"a":')).toEqual([])
    expect(rec.flush()).toEqual(['{"a":'])
    expect(rec.flush()).toEqual([])
  })

  test("sticky packets: many frames in one chunk", () => {
    const rec = createLineReconstructor()
    const chunk = [1, 2, 3].map((n) => encodeFrame({ n })).join("")
    expect(rec.push(chunk)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}'])
  })
})

test("frame cap applies per UTF8 frame independent of sticky packet partitioning", () => {
  const frame = '"中文"'
  for (const chunks of [
    [`${frame}\n${frame}\n`],
    [frame, `\n${frame}\n`],
    [...`${frame}\n${frame}\n`],
  ]) {
    const rec = createLineReconstructor({ maxFrameBytes: 8 })
    expect(chunks.flatMap((chunk) => rec.push(chunk))).toEqual([frame, frame])
  }
  const rec = createLineReconstructor({ maxFrameBytes: 7 })
  expect(() => rec.push(`${frame}\n`)).toThrow(/exceeded/)
})
