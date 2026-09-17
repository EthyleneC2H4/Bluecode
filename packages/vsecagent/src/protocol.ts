import { SECURITY_MAX_TEXT_BYTES, VSEC_PROTOCOL_VERSION } from "@bluecode/contracts"
export const PROTOCOL = VSEC_PROTOCOL_VERSION
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const MAX_PENDING = 32
export type VsecOperation = "evaluate" | "sanitize" | "health"
export interface VsecTiming { requestId: string; queueMs: number; serviceMs: number; policyVersion: string }
export interface VsecHealth {
  pid: number
  protocol: 1
  uptimeMs: number
  cacheBytes: number
  cacheHits: number
  serviceMs: number
  rssBytes: number
}
export interface VsecRequest { protocol: 1; id: string; op: VsecOperation; params: unknown; queueMs: number }
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
export function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 }
export function requestId(value: unknown): value is string { return typeof value === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(value) }
/** Inspect before JSON serialization so cycles, recursion and oversized nested args stay bounded. */
export function boundedInput(value: unknown): boolean {
  const queue: Array<[unknown, number]> = [[value, 0]], seen = new Set<object>()
  let bytes = 0, count = 0
  while (queue.length) {
    const [item, depth] = queue.pop()!
    if (++count > 65536 || depth > 32) return false
    if (typeof item === "string") {
      const size = Buffer.byteLength(item)
      if (size > SECURITY_MAX_TEXT_BYTES || (bytes += size) > MAX_FRAME_BYTES) return false
    } else if (item !== null && typeof item === "object") {
      if (seen.has(item)) return false
      seen.add(item)
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false
      for (const [key, child] of Object.entries(item)) {
        queue.push([key, depth + 1], [child, depth + 1])
        if (queue.length > 65536) return false
      }
    } else if (item !== null && typeof item !== "boolean" && (typeof item !== "number" || !Number.isFinite(item))) return false
  }
  return true
}
/** One byte ceiling for complete and unterminated frames, including multibyte UTF-8. */
export async function readFrames(stream: ReadableStream<Uint8Array>, consume: (line: string) => void | Promise<void>): Promise<void> {
  let chunks: Buffer[] = [], bytes = 0
  for await (const value of stream) {
    const chunk = Buffer.from(value)
    let start = 0
    for (let end = 0; end < chunk.length; end++) {
      if (chunk[end] !== 10) continue
      const part = chunk.subarray(start, end)
      if (bytes + part.length > MAX_FRAME_BYTES) throw new Error("frame-limit")
      chunks.push(part)
      await consume(Buffer.concat(chunks, bytes + part.length).toString("utf8"))
      chunks = []; bytes = 0; start = end + 1
    }
    const tail = chunk.subarray(start)
    if ((bytes += tail.length) > MAX_FRAME_BYTES) throw new Error("frame-limit")
    if (tail.length) chunks.push(tail)
  }
  if (bytes) throw new Error("truncated-frame")
}
