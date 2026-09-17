import { expect, test } from "bun:test"
import { MAX_FRAME_BYTES, readFrames, boundedInput } from "../src/protocol"
function stream(chunks: Uint8Array[]) { return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } }) }
test("byte framing reconstructs split Unicode and several lines from one chunk", async () => {
  const bytes = Buffer.from('文\nsecond\n')
  const lines: string[] = []
  await readFrames(stream([bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2)]), line => { lines.push(line) })
  expect(lines).toEqual(["文", "second"])
})
test("frame ceiling includes multibyte bytes and rejects incomplete terminal frames", async () => {
  await expect(readFrames(stream([Buffer.from("文".repeat(Math.ceil(MAX_FRAME_BYTES / 3)))]), () => {})).rejects.toThrow("frame-limit")
  await expect(readFrames(stream([Buffer.from("incomplete")]), () => {})).rejects.toThrow("truncated-frame")
})
test("pre-serialization bounds reject deep objects, non-JSON values and Unicode fields", () => {
  let deep: unknown = "end"
  for (let index = 0; index < 34; index++) deep = { nested: deep }
  for (const input of [deep, { v: NaN }, { v: Infinity }, { v: new Date() }, { v: undefined }, { v: "文".repeat(400000) }]) expect(boundedInput(input)).toBe(false)
  expect(boundedInput({ nested: ["safe", 1, true, null] })).toBe(true)
})
