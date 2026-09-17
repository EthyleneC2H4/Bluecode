/** Host boundary: no scanners, TypeScript, WASM, SQLite or storage imports. */
import {
  securityDecisionSchema, securitySanitizeResultSchema, securityEvaluateParamsSchema, securitySanitizeParamsSchema,
  type SecurityDecision, type SecurityEvaluateParams, type SecuritySanitizeParams, type SecuritySanitizeResult,
} from "@bluecode/contracts"
import { bunSpawnArgv } from "@bluecode/shared"
import { fileURLToPath } from "node:url"
import { boundedInput, finite, MAX_FRAME_BYTES, MAX_PENDING, PROTOCOL, readFrames, record, type VsecHealth, type VsecOperation, type VsecTiming } from "./protocol"
export type { VsecHealth, VsecTiming } from "./protocol"
export type VsecUnavailableReason = "startup" | "timeout" | "crash" | "protocol" | "overloaded" | "input" | "closed" | "service"
export class VsecUnavailableError extends Error {
  constructor(readonly reason: VsecUnavailableReason) {
    super(`Security scanner unavailable (${reason})`)
    this.name = "VsecUnavailableError"
  }
}
export interface VsecClientOptions { dataDir: string; entry?: string; timeoutMs?: number; maxQueuedRequests?: number; maxQueuedBytes?: number }
type Child = import("bun").Subprocess<"pipe", "pipe", "ignore">
interface Generation { child: Child; ready: boolean; failStartup: () => void; resolveStartup: () => void }
interface Pending {
  id: string; op: VsecOperation; payload: string; bytes: number; entered: number
  resolve: (value: unknown) => void; reject: (error: VsecUnavailableError) => void
  timer: ReturnType<typeof setTimeout>
}
export class VsecClient {
  private generation: Generation | undefined
  private starting: Promise<void> | undefined
  private active: Pending | undefined
  private readonly pending: Pending[] = []
  private pendingBytes = 0
  private closed = false
  private pumping = false
  private readonly timeoutMs: number
  private readonly maxPending: number
  private readonly maxBytes: number
  private constructor(private readonly options: VsecClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 1000
    this.maxPending = Math.min(options.maxQueuedRequests ?? MAX_PENDING, MAX_PENDING)
    this.maxBytes = Math.min(options.maxQueuedBytes ?? MAX_FRAME_BYTES, MAX_FRAME_BYTES)
    if (![this.timeoutMs, this.maxPending, this.maxBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new VsecUnavailableError("input")
  }
  static async create(options: VsecClientOptions): Promise<VsecClient> {
    const client = new VsecClient(options)
    await client.ensureStarted()
    return client
  }
  evaluateTool(params: SecurityEvaluateParams): Promise<SecurityDecision & VsecTiming> { return this.enqueue("evaluate", params) as Promise<SecurityDecision & VsecTiming> }
  sanitize(params: SecuritySanitizeParams): Promise<SecuritySanitizeResult & VsecTiming> { return this.enqueue("sanitize", params) as Promise<SecuritySanitizeResult & VsecTiming> }
  health(): Promise<VsecHealth> { return this.enqueue("health", {}) as Promise<VsecHealth> }
  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new VsecUnavailableError("closed")
    if (this.starting) return this.starting
    if (this.generation?.ready) return
    this.starting = this.start().finally(() => { this.starting = undefined })
    return this.starting
  }
  private async start(): Promise<void> {
    let child: Child
    try {
      const entry = this.options.entry ?? fileURLToPath(new URL("./bin.ts", import.meta.url))
      child = Bun.spawn(bunSpawnArgv(entry), { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, BLUECODE_VSEC_DATA_DIR: this.options.dataDir } })
    } catch { throw new VsecUnavailableError("startup") }
    let resolveStartup!: () => void, rejectStartup!: (error: VsecUnavailableError) => void
    const ready = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject })
    const generation: Generation = { child, ready: false, resolveStartup, failStartup: () => rejectStartup(new VsecUnavailableError("startup")) }
    this.generation = generation
    const timer = setTimeout(() => this.failGeneration(generation, "startup"), 10_000)
    void readFrames(child.stdout, line => this.receive(generation, line)).catch(() => this.failGeneration(generation, generation.ready ? "protocol" : "startup"))
    void child.exited.then(() => this.failGeneration(generation, generation.ready ? "crash" : "startup"))
    try { await ready } finally { clearTimeout(timer) }
  }
  private failGeneration(generation: Generation, reason: VsecUnavailableReason): void {
    if (this.generation !== generation) return
    this.generation = undefined
    generation.failStartup()
    try { generation.child.kill("SIGKILL") } catch {}
    for (const item of [...this.pending]) this.finish(item, new VsecUnavailableError(reason))
  }
  private finish(item: Pending, error?: VsecUnavailableError, value?: unknown): void {
    const index = this.pending.indexOf(item)
    if (index < 0) return
    this.pending.splice(index, 1)
    this.pendingBytes -= item.bytes
    clearTimeout(item.timer)
    if (this.active === item) this.active = undefined
    if (error) item.reject(error)
    else item.resolve(value)
  }
  private receive(generation: Generation, line: string): void {
    if (this.generation !== generation) return
    let response: unknown
    try { response = JSON.parse(line) } catch { this.failGeneration(generation, "protocol"); return }
    if (!record(response) || response.protocol !== PROTOCOL) { this.failGeneration(generation, generation.ready ? "protocol" : "startup"); return }
    if (!generation.ready) {
      if (response.type !== "ready" || response.pid !== generation.child.pid) { this.failGeneration(generation, "startup"); return }
      generation.ready = true; generation.resolveStartup(); return
    }
    if (typeof response.id !== "string") { this.failGeneration(generation, "protocol"); return }
    const item = this.active
    // Uncorrelated replies cannot settle a request, including duplicates and old generations.
    if (!item || response.id !== item.id) return
    if (response.ok === false) { this.finish(item, new VsecUnavailableError("service")); void this.pump(); return }
    const timing = response.timing
    if (response.ok !== true || !record(timing) || timing.requestId !== item.id || !finite(timing.queueMs) || !finite(timing.serviceMs) || typeof timing.policyVersion !== "string") { this.failGeneration(generation, "protocol"); return }
    let result: unknown
    if (item.op === "health") {
      const h = response.result
      if (!record(h) || h.protocol !== PROTOCOL || h.pid !== generation.child.pid || ![h.uptimeMs, h.cacheBytes, h.cacheHits, h.serviceMs, h.rssBytes].every(finite)) { this.failGeneration(generation, "protocol"); return }
      result = h
    } else {
      const parsed = (item.op === "evaluate" ? securityDecisionSchema : securitySanitizeResultSchema).safeParse(response.result)
      if (!parsed.success || parsed.data.policyVersion !== timing.policyVersion) { this.failGeneration(generation, "protocol"); return }
      if (item.op === "sanitize" && "fields" in parsed.data && parsed.data.fields.length !== (JSON.parse(item.payload) as SecuritySanitizeParams).fields.length) { this.failGeneration(generation, "protocol"); return }
      result = { ...parsed.data, ...timing }
    }
    this.finish(item, undefined, result)
    void this.pump()
  }
  private async enqueue(op: VsecOperation, params: unknown): Promise<unknown> {
    const entered = performance.now()
    if (this.closed) throw new VsecUnavailableError("closed")
    let payload: string
    try {
      if (!boundedInput(params)) throw new Error()
      if (op === "sanitize" && !securitySanitizeParamsSchema.safeParse(params).success || op === "evaluate" && !securityEvaluateParamsSchema.safeParse(params).success) throw new Error()
      payload = JSON.stringify(params)
    } catch { throw new VsecUnavailableError("input") }
    const bytes = Buffer.byteLength(payload) + 256
    if (bytes > MAX_FRAME_BYTES) throw new VsecUnavailableError("input")
    if (this.pending.length >= this.maxPending || this.pendingBytes + bytes > this.maxBytes) throw new VsecUnavailableError("overloaded")
    if (performance.now() - entered >= this.timeoutMs) throw new VsecUnavailableError("timeout")
    return new Promise((resolve, reject) => {
      const item: Pending = { id: crypto.randomUUID(), op, payload, bytes, entered, resolve, reject,
        timer: setTimeout(() => {
          if (!this.pending.includes(item)) return
          if (this.generation) this.failGeneration(this.generation, "timeout")
          else this.finish(item, new VsecUnavailableError("timeout"))
        }, Math.max(1, this.timeoutMs - (performance.now() - entered))) }
      this.pending.push(item); this.pendingBytes += bytes
      void this.pump()
    })
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.active || this.closed || !this.pending.length) return
    this.pumping = true
    try {
      await this.ensureStarted()
      const item = this.pending[0], generation = this.generation
      if (!item || !generation?.ready || this.closed) return
      this.active = item
      const queueMs = performance.now() - item.entered
      generation.child.stdin.write(`{"protocol":1,"id":"${item.id}","op":"${item.op}","queueMs":${queueMs},"params":${item.payload}}\n`)
      await generation.child.stdin.flush()
    } catch {
      if (this.generation) this.failGeneration(this.generation, "crash")
      else for (const item of [...this.pending]) this.finish(item, new VsecUnavailableError(this.closed ? "closed" : "startup"))
    } finally { this.pumping = false; if (!this.active && this.pending.length) void this.pump() }
  }
  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const generation = this.generation
    if (generation) { this.failGeneration(generation, "closed"); await generation.child.exited }
    else for (const item of [...this.pending]) this.finish(item, new VsecUnavailableError("closed"))
  }
}
