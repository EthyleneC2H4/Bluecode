import { securityPolicySchema, SECURITY_MAX_TEXT_BYTES } from "@bluecode/contracts"
import { redact } from "./credentials"

const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** Bounded recursive shape walk also rejects cycles, non-JSON values and excessive depth. */
export function texts(value: unknown): string[] | undefined {
  const result: string[] = [], seen = new Set<object>()
  const queue: Array<[unknown, number]> = [[value, 0]]
  let bytes = 0, count = 0
  while (queue.length) {
    const [item, depth] = queue.pop()!
    if (++count > 65536 || depth > 32) return undefined
    if (typeof item === "string") {
      const size = new TextEncoder().encode(item).length
      bytes += size
      if (size > SECURITY_MAX_TEXT_BYTES || bytes > MAX_TOTAL_BYTES) return undefined
      result.push(item)
    } else if (item !== null && typeof item === "object") {
      if (seen.has(item)) return undefined
      seen.add(item)
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return undefined
      for (const [key, child] of Object.entries(item)) {
        queue.push([key, depth + 1], [child, depth + 1])
        if (queue.length > 65536) return undefined
      }
    } else if (item !== null && !["number", "boolean"].includes(typeof item)) return undefined
    else if (typeof item === "number" && !Number.isFinite(item)) return undefined
  }
  return result
}
export function version(policy: unknown): string {
  const parsed = securityPolicySchema.safeParse(policy)
  return parsed.success ? redact(parsed.data.version).text : "invalid-policy"
}
