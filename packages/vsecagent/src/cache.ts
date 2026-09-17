import { createHash } from "node:crypto"
export const MAX_CACHE_BYTES = 16 * 1024 * 1024
export const PARSER_VERSION = "typescript@5.9.3/web-tree-sitter@0.25.10/tree-sitter-bash@0.25.0"
export function cacheKey(operation: string, params: unknown, parserVersion = PARSER_VERSION): string {
  return createHash("sha256").update(JSON.stringify([operation, parserVersion, params])).digest("hex")
}
/** Serialized results only, never input source. Hard bound includes UTF-8 keys and entry overhead. */
export class BoundedCache {
  private readonly entries = new Map<string, { json: string; size: number; expiresAt: number }>()
  bytes = 0
  hits = 0
  readonly limit: number
  constructor(limit = MAX_CACHE_BYTES) { this.limit = Math.max(0, Math.min(limit, MAX_CACHE_BYTES)) }
  get<T = unknown>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    if (entry.expiresAt <= Date.now()) { this.bytes -= entry.size; return undefined }
    this.entries.set(key, entry)
    this.hits++
    return JSON.parse(entry.json) as T
  }
  set(key: string, value: unknown, expiresAt: number): void {
    const previous = this.entries.get(key)
    if (previous) { this.bytes -= previous.size; this.entries.delete(key) }
    const json = JSON.stringify(value), size = Buffer.byteLength(json) + Buffer.byteLength(key) + 64
    if (size > this.limit || expiresAt <= Date.now()) return
    while (this.bytes + size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.bytes -= this.entries.get(oldest)!.size
      this.entries.delete(oldest)
    }
    this.entries.set(key, { json, size, expiresAt }); this.bytes += size
  }
}
