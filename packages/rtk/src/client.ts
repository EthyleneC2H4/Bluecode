/**
 * Plugin-side client for the rtk server subprocess.
 *
 * Owns the full degradation matrix at the process boundary:
 * - pre-warmed spawn at create() time (never on the per-request path)
 * - client-side fast path below minBytes (no IPC at all)
 * - serial request/response with id correlation and late-response discard
 * - per-request timeout -> passthrough "timeout" (child stays up); a late
 *   reply to a timed-out id is dropped via the late-reply ring and never
 *   feeds the protocol streak — three timeouts alone cannot kill the child
 * - child crash -> in-flight "crash", exponential-backoff restart
 * - restart budget exhausted -> passthrough-only breaker, background probes
 * - protocol garbage streak -> same treatment as a crash
 *
 * Every passthrough carries the original input text unchanged: a degraded
 * rtk must never alter tool output, only skip compression.
 */
import {
  PROTOCOL_VERSION,
  compressResultSchema,
  fetchResultSchema,
  helloSchema,
  pingResultSchema,
  responseSchema,
  statsResultSchema,
  type CompressResult,
  type DegradedReason,
  type PingResult,
  type RtkOp,
  type StatsResult,
} from "@bluecode/contracts"
import {
  bunSpawnArgv,
  createLineReconstructor,
  encodeFrame,
  FrameOverflowError,
  newRequestId,
} from "@bluecode/shared"
import { fileURLToPath } from "node:url"
import { DEFAULT_DATA_DIR } from "./paths"

export interface RtkClientOptions {
  /** Server entry file (default: this package's src/bin.ts). */
  entry?: string
  /** Child working directory (default: inherit the caller's cwd). */
  cwd?: string
  /** Compression token budget sent with compress ops. Default 512. */
  budgetTokens?: number
  /** Per-request timeout. Default 40ms. */
  timeoutMs?: number
  retrievalTimeoutMs?: number
  maxStorageBytes?: number
  /** Outputs under this many bytes never reach the server. Default 512. */
  minBytes?: number
  /** CAS root passed to the child as BLUECODE_DATA_DIR. Default: per-uid sidecar dir. */
  dataDir?: string
  /** Restart attempts before the breaker trips. Default 5. */
  maxRestartAttempts?: number
  /** Breaker probe interval (spawn attempt). Default 30_000ms. */
  probeIntervalMs?: number
  /** Run the child with BLUECODE_TEST=1 (test-only ops / delay hook). */
  testMode?: boolean
  /**
   * Extra env vars merged over process.env for the child (tests inject
   * BLUECODE_TEST_DELAY_MS here without polluting their own environment).
   */
  serverEnv?: Record<string, string>
  /**
   * Client-side frame-size ceiling for the stdout/stderr reconstructor
   * (default 8 MiB, shared's own default). Test hook so the overflow ->
   * protocol-failure mapping is exercisable without megabyte frames.
   */
  maxFrameBytes?: number
}

const DEFAULTS = {
  budgetTokens: 512,
  timeoutMs: 40,
  minBytes: 512,
  maxRestartAttempts: 5,
  probeIntervalMs: 30_000,
} as const

/** First restart backoff step; attempt n waits RESTART_BACKOFF_MS * 2^(n-1). */
const RESTART_BACKOFF_MS = 250
/** Handshake budget for spawn/probe attempts. */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** SIGTERM grace before a shutdown escalates to SIGKILL. */
const SHUTDOWN_GRACE_MS = 3_000
/**
 * Ring size for recently timed-out request ids. A slow child's late replies
 * arrive after their waiter gave up; counting them as protocol garbage would
 * let three timeouts alone trip the SIGKILL, contradicting the "child stays
 * up" timeout contract. The ring bounds memory while tolerating every reply
 * a serial-queue client can legitimately have in flight.
 */
const LATE_REPLY_RING = 64
/**
 * Generous default for the ops/debug surface (ping/stats): these are
 * liveness calls, not compression calls, so they may outlive the tight
 * compress/fetch timeout. Callers can pass a tighter budget explicitly.
 */
const OPS_TIMEOUT_MS = 10_000

export type CompressOutcome =
  | { kind: "compressed"; result: CompressResult }
  | {
      kind: "passthrough"
      output: string
      degraded: DegradedReason | null
      status?: "unchanged" | "skipped" | "degraded"
      result?: CompressResult
    }

export type FetchOutcome =
  | { kind: "found"; content: string; nextCursor: string | null; truncated: boolean }
  | { kind: "missing" }
  | { kind: "unavailable"; degraded: DegradedReason }

export interface CompressInput {
  tool: string
  output: string
  title?: string
  toolArgs?: import("@bluecode/contracts").CompressParams["toolArgs"]
  source?: import("@bluecode/contracts").CompressParams["source"]
  provenance?: import("@bluecode/contracts").CompressParams["provenance"]
  metadata?: Record<string, unknown>
  sessionId: string
  callId?: string
}

export interface FetchInput {
  hash: string
  sessionId: string
  cursor?: string
  maxTokens?: number
  maxBytes?: number
}

/** Well-formed ok:false response — a caller bug, not a transport failure. */
export class RtkServerError extends Error {
  readonly code: string
  readonly detail?: unknown
  constructor(code: string, message: string, detail?: unknown) {
    super(`rtk server error ${code}: ${message}`)
    this.name = "RtkServerError"
    this.code = code
    this.detail = detail
  }
}

/** Why an in-flight request gave up (mapped onto DegradedReason by callers). */
type PendingFailure =
  | { kind: "timeout" }
  | { kind: "crash" }
  | { kind: "protocol"; message: string }
  | { kind: "unready" }
  | { kind: "overloaded" }

interface PendingRequest {
  op: Exclude<RtkOp, "simulateCrash">
  resolve: (result: unknown) => void
  reject: (reason: PendingFailure | RtkServerError | Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ClientDiag {
  queuedRequests: number
  queuedBytes: number
  /** Total spawn/handshake attempts (initial, restarts, probes). */
  spawns: number
  /** Successful respawns after a down-period (restarts + breaker recovery). */
  recoveries: number
  breakerOpen: boolean
  /** Current restart attempt within one down-period (0 when healthy). */
  restartAttempt: number
}

type RtkProc = import("bun").Subprocess<"pipe", "pipe", "pipe">

/** Per-op result schemas — every incoming payload is checked against these. */
const RESULT_SCHEMAS = {
  compress: compressResultSchema,
  fetch: fetchResultSchema,
  ping: pingResultSchema,
  stats: statsResultSchema,
} as const

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build the interpreter argv that runs a TS entry file.
 *
 * Lives in @bluecode/shared since the M7 compiled-host fix applies to every
 * sidecar spawn; re-exported here for API compatibility.
 */
export { bunSpawnArgv }

export class RtkClient {
  private readonly opts: {
    budgetTokens: number
    timeoutMs: number
    retrievalTimeoutMs: number
    maxStorageBytes: number
    minBytes: number
    maxRestartAttempts: number
    probeIntervalMs: number
    testMode: boolean
    cwd: string | undefined
    serverEnv: Record<string, string> | undefined
    maxFrameBytes: number | undefined
  }
  private readonly entryPath: string
  private readonly dataDir: string

  private proc: RtkProc | null = null
  private ready = false
  private helloPid: number | null = null
  private shuttingDown = false
  private shutdownPromise: Promise<void> | null = null
  private spawning = false
  private breakerOpen = false
  private restartAttempt = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private protocolStreak = 0
  /** Recently timed-out ids (insertion-ordered ring); see LATE_REPLY_RING. */
  private readonly lateReplyIds = new Set<string>()
  private readonly pending = new Map<string, PendingRequest>()
  private queuedBytes = 0
  private readonly queue: Array<{ id: string; frame: string; deadline: number; proc: RtkProc }> = []
  private inFlightId: string | null = null
  private stalledTimer: ReturnType<typeof setTimeout> | null = null
  private spawns = 0
  private recoveries = 0

  private constructor(opts: RtkClientOptions) {
    this.opts = {
      budgetTokens: opts.budgetTokens ?? DEFAULTS.budgetTokens,
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      retrievalTimeoutMs: opts.retrievalTimeoutMs ?? 500,
      maxStorageBytes: opts.maxStorageBytes ?? 1024 ** 3,
      minBytes: opts.minBytes ?? DEFAULTS.minBytes,
      maxRestartAttempts: opts.maxRestartAttempts ?? DEFAULTS.maxRestartAttempts,
      probeIntervalMs: opts.probeIntervalMs ?? DEFAULTS.probeIntervalMs,
      testMode: opts.testMode ?? false,
      cwd: opts.cwd,
      serverEnv: opts.serverEnv,
      maxFrameBytes: opts.maxFrameBytes,
    }
    // Sibling of this module: stable regardless of the caller's layout.
    // fileURLToPath over .pathname: .pathname keeps percent-encoding and, on
    // Windows, yields "/C:/..." which neither Bun nor CreateProcess resolves —
    // the compiled-host smoke (M7) class of silent spawn failure.
    this.entryPath = opts.entry ?? fileURLToPath(new URL("./bin.ts", import.meta.url))
    this.dataDir = opts.dataDir ?? DEFAULT_DATA_DIR
  }

  /**
   * Spawn the server and wait for its handshake now, so later requests are
   * pure IPC (the per-request path never spawns).
   */
  static async create(opts: RtkClientOptions = {}): Promise<RtkClient> {
    const client = new RtkClient(opts)
    try {
      await client.spawnAndGreet()
      return client
    } catch (error) {
      await client.shutdown()
      throw error
    }
  }

  // ------------------------------------------------------------------ info --

  /** pid from the live handshake; null while down/restarting/broken. */
  get serverPid(): number | null {
    return this.ready ? this.helloPid : null
  }

  /** Introspection for tests and ops dashboards. */
  get diag(): ClientDiag {
    return {
      queuedRequests: this.pending.size,
      queuedBytes: this.queuedBytes,
      spawns: this.spawns,
      recoveries: this.recoveries,
      breakerOpen: this.breakerOpen,
      restartAttempt: this.restartAttempt,
    }
  }

  // ----------------------------------------------------------- public ops --

  async compress(input: CompressInput): Promise<CompressOutcome> {
    const admittedAt = performance.now()
    // Fast path: tiny outputs bypass the process boundary entirely.
    if (Buffer.byteLength(input.output, "utf8") < this.opts.minBytes) {
      return { kind: "passthrough", output: input.output, degraded: null, status: "skipped" }
    }

    const params: Record<string, unknown> = { tool: input.tool, output: input.output }
    if (input.toolArgs !== undefined) params.toolArgs = input.toolArgs
    if (input.source !== undefined) params.source = input.source
    if (input.provenance !== undefined) params.provenance = input.provenance
    if (input.title !== undefined) params.title = input.title
    if (input.metadata !== undefined) params.metadata = input.metadata
    params.sessionId = input.sessionId
    if (input.callId !== undefined) params.callId = input.callId
    params.budgetTokens = this.opts.budgetTokens

    try {
      const result = compressResultSchema.parse(
        await this.request(
          "compress",
          params,
          this.opts.timeoutMs - (performance.now() - admittedAt)
        )
      )
      return result.compressed && result.status === "compressed"
        ? { kind: "compressed", result }
        : {
            kind: "passthrough",
            output: result.output,
            degraded:
              result.degraded?.reason === "no_gain" ? null : result.degraded?.reason ?? null,
            status: result.status === "degraded" ? "degraded" : "unchanged",
            result,
          }
    } catch (err) {
      const degraded = degradeFrom(err)
      if (degraded === null) throw err
      return { kind: "passthrough", output: input.output, degraded, status: "degraded" }
    }
  }

  async fetch(input: FetchInput): Promise<FetchOutcome> {
    const admittedAt = performance.now()
    try {
      const result = fetchResultSchema.parse(
        await this.request(
          "fetch",
          input,
          this.opts.retrievalTimeoutMs - (performance.now() - admittedAt)
        )
      )
      return result.found
        ? {
            kind: "found",
            content: result.content,
            nextCursor: result.nextCursor,
            truncated: result.truncated,
          }
        : { kind: "missing" }
    } catch (err) {
      const degraded = degradeFrom(err)
      if (degraded === null) throw err
      return { kind: "unavailable", degraded }
    }
  }

  /** Liveness check through the full IPC stack. Throws on transport failure. */
  async ping(timeoutMs: number = OPS_TIMEOUT_MS): Promise<PingResult> {
    const result = pingResultSchema.parse(await this.request("ping", {}, timeoutMs))
    return result
  }

  /** Pipeline counters from the server. Throws on transport failure. */
  async stats(timeoutMs: number = OPS_TIMEOUT_MS): Promise<StatsResult> {
    const result = statsResultSchema.parse(await this.request("stats", {}, timeoutMs))
    return result
  }

  /** Graceful close: SIGTERM, escalate to SIGKILL after the grace window. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise
    this.shutdownPromise = this.doShutdown()
    return this.shutdownPromise
  }

  private async doShutdown(): Promise<void> {
    this.shuttingDown = true
    this.clearTimers()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("RtkClient is shutting down"))
    }
    this.pending.clear()

    const proc = this.proc
    this.ready = false
    this.proc = null
    if (proc !== null) {
      await this.terminateChild(proc)
    }
  }

  private async terminateChild(proc: RtkProc): Promise<void> {
    proc.kill()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)
        }),
      ])
      if (!exited) proc.kill("SIGKILL")
      await proc.exited
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // -------------------------------------------------------------- request --

  /**
   * One serialized request/response round trip. Rejects with PendingFailure
   * (transport-level, mapped to a DegradedReason) or RtkServerError
   * (well-formed server-side refusal — caller bug, propagated as-is).
   */
  private request(
    op: Exclude<RtkOp, "simulateCrash">,
    params: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("RtkClient is shut down"))
    }
    if (!this.ready || this.proc === null || this.breakerOpen || this.spawning) {
      // Down-window (restarting backoff or open breaker): fail fast instead
      // of queueing behind a spawn that may not succeed.
      return Promise.reject({ kind: "unready" } satisfies PendingFailure)
    }

    const deadline = performance.now() + timeoutMs
    const id = newRequestId("rtk")
    const frame = encodeFrame({ v: PROTOCOL_VERSION, id, op, params })
    const bytes = Buffer.byteLength(frame, "utf8")
    if (this.pending.size >= 32 || this.queuedBytes + bytes > 8 * 1024 * 1024) {
      return Promise.reject({ kind: "overloaded" } satisfies PendingFailure)
    }
    const proc = this.proc
    this.queuedBytes += bytes
    return new Promise<unknown>((resolve, reject) => {
      const settle = (value: unknown, failed: boolean): void => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        this.queuedBytes -= bytes
        const idx = this.queue.findIndex((entry) => entry.id === id)
        if (idx !== -1) this.queue.splice(idx, 1)
        if (failed) reject(value)
        else resolve(value)
        queueMicrotask(() => this.drainQueue())
      }
      const timer = setTimeout(
        () => {
          if (this.inFlightId === id) {
            this.rememberLateReply(id)
            // Serialization must not stay occupied forever when a response was
            // replaced by garbage or the child is alive but no longer answering.
            this.stalledTimer = setTimeout(() => {
              this.stalledTimer = null
              if (this.proc === proc && this.inFlightId === id && !this.shuttingDown)
                proc.kill("SIGKILL")
            }, 1000)
          }
          settle({ kind: "timeout" }, true)
        },
        Math.max(0, deadline - performance.now())
      )
      this.pending.set(id, {
        op,
        timer,
        resolve: (value) => settle(value, false),
        reject: (err) => settle(err, true),
      })
      this.queue.push({ id, frame, deadline, proc })
      this.drainQueue()
    })
  }

  private drainQueue(): void {
    if (this.inFlightId !== null) return
    while (this.queue.length > 0) {
      const job = this.queue.shift()!
      const pending = this.pending.get(job.id)
      if (!pending) continue
      if (performance.now() >= job.deadline) {
        pending.reject({ kind: "timeout" })
        continue
      }
      if (this.proc !== job.proc || !this.ready || this.shuttingDown) {
        pending.reject({ kind: "unready" })
        continue
      }
      try {
        this.inFlightId = job.id
        job.proc.stdin.write(job.frame)
      } catch {
        this.inFlightId = null
        pending.reject({ kind: "crash" })
      }
      return
    }
  }

  // ------------------------------------------------------------- lifecycle --

  private async spawnAndGreet(): Promise<void> {
    this.spawning = true
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        BLUECODE_DATA_DIR: this.dataDir,
        BLUECODE_MAX_STORAGE_BYTES: String(this.opts.maxStorageBytes),
        ...this.opts.serverEnv,
      }
      if (this.opts.testMode) env.BLUECODE_TEST = "1"

      const proc = Bun.spawn(bunSpawnArgv(this.entryPath), {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.opts.cwd ?? process.cwd(),
        env,
      }) as RtkProc
      this.spawns += 1
      this.proc = proc

      const hello = deferred<{ proto: 3; pid: number }>()
      this.pumpStdout(proc, hello)
      this.pumpStderr(proc)

      proc.exited.then((code) => this.onChildExit(proc, code)).catch(() => {})

      const handshake = Promise.race([
        hello.promise,
        proc.exited.then(() => {
          throw new Error("rtk server exited during handshake")
        }),
        sleep(HANDSHAKE_TIMEOUT_MS).then(() => {
          throw new Error(`rtk server handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`)
        }),
      ])
      try {
        const greeting = await handshake
        this.helloPid = greeting.pid
      } catch (err) {
        // Handshake failed: make sure the half-born child cannot linger.
        await this.terminateChild(proc)
        if (this.proc === proc) this.proc = null
        throw err
      }

      this.ready = true
      this.restartAttempt = 0
      this.protocolStreak = 0
      this.lateReplyIds.clear() // a fresh child cannot answer the old one's requests
    } finally {
      this.spawning = false
    }
  }

  private pumpStdout(
    proc: RtkProc,
    hello: { resolve: (v: { proto: 3; pid: number }) => void; reject: (e: unknown) => void }
  ): void {
    void (async () => {
      const decoder = new TextDecoder()
      const frames = createLineReconstructor(
        this.opts.maxFrameBytes !== undefined ? { maxFrameBytes: this.opts.maxFrameBytes } : {}
      )
      let helloDone = false
      // Feed one decoded chunk, keeping overflow LOCAL: an escaped throw would
      // tear down the whole pump, capping the strike count at one.
      const feed = (text: string): void => {
        if (this.proc !== proc) return
        let lines: string[]
        let overflow: FrameOverflowError | undefined
        try {
          lines = frames.push(text)
        } catch (err) {
          if (err instanceof FrameOverflowError) {
            // Oversized frame poisons stream framing; the reconstructor has
            // already dropped its buffer, so keep pumping and let the streak
            // machinery own the child's fate (FIX 8 mapping).
            lines = err.completedLines
            overflow = err
          } else {
            throw err
          }
        }
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as string
          if (!helloDone && this.proc === proc) {
            helloDone = true
            this.consumeHello(line, hello)
          } else {
            this.onFrame(line)
          }
        }
        if (overflow)
          this.protocolFailure(`response frame exceeded ${overflow.maxFrameBytes} bytes`)
      }
      try {
        for await (const chunk of proc.stdout) {
          feed(decoder.decode(chunk, { stream: true }))
        }
        // Finalize the decoder before flushing: a multibyte char split at EOF
        // lives in the decoder, not the reconstructor (devlog #35).
        feed(decoder.decode())
        if (this.proc === proc) for (const line of frames.flush()) this.onFrame(line)
      } catch {
        // Stream died; the exited handler performs crash bookkeeping.
      }
    })()
  }

  private consumeHello(
    line: string,
    hello: { resolve: (v: { proto: 3; pid: number }) => void; reject: (e: unknown) => void }
  ): void {
    try {
      hello.resolve(helloSchema.parse(JSON.parse(line)))
    } catch (err) {
      hello.reject(new Error(`rtk server sent an invalid handshake: ${String(err)}`))
    }
  }

  private pumpStderr(proc: RtkProc): void {
    void (async () => {
      const decoder = new TextDecoder()
      const frames = createLineReconstructor(
        this.opts.maxFrameBytes !== undefined ? { maxFrameBytes: this.opts.maxFrameBytes } : {}
      )
      const emit = (line: string): void => console.error(`[rtk-server ${proc.pid}] ${line}`)
      try {
        for await (const chunk of proc.stderr) {
          let lines: string[]
          try {
            lines = frames.push(decoder.decode(chunk, { stream: true }))
          } catch (err) {
            if (err instanceof FrameOverflowError) {
              // Diagnostics only: drop the oversized runt, never the pump.
              for (const line of err.completedLines) emit(line)
              emit(`<stderr frame overflow: >${err.maxFrameBytes} bytes dropped>`)
              continue
            }
            throw err
          }
          for (const line of lines) emit(line)
        }
        // Same EOF finalization as the stdout pump (devlog #35); stderr is
        // diagnostics, so the tail lines just go to the console.
        for (const line of frames.push(decoder.decode())) emit(line)
        for (const line of frames.flush()) emit(line)
      } catch {
        // stderr is best effort.
      }
    })()
  }

  /** One stdout frame from the server (post-handshake). */
  private onFrame(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.protocolFailure("response frame is not valid JSON")
      return
    }
    const envelope = responseSchema.safeParse(parsed)
    if (!envelope.success) {
      this.protocolFailure("response envelope failed schema validation")
      return
    }
    const msg = envelope.data
    if (this.inFlightId === msg.id) {
      if (this.stalledTimer) clearTimeout(this.stalledTimer)
      this.stalledTimer = null
      this.inFlightId = null
      queueMicrotask(() => this.drainQueue())
    }

    if (msg.ok === false) {
      const pending = this.pending.get(msg.id)
      if (pending !== undefined) {
        clearTimeout(pending.timer)
        pending.reject(new RtkServerError(msg.error.code, msg.error.message, msg.error.detail))
      }
      // Well-formed error responses are protocol traffic, not corruption.
      this.protocolStreak = 0
      return
    }

    const pending = this.pending.get(msg.id)
    if (pending === undefined) {
      // A reply to a recently timed-out id is dropped by id (never attributed
      // to the next exchange) WITHOUT feeding the protocol streak — slowness
      // is not corruption. Unknown ids are genuine garbage: count them.
      if (this.lateReplyIds.delete(msg.id)) return
      this.protocolStreak += 1
      this.checkProtocolStreak()
      return
    }

    const checked = RESULT_SCHEMAS[pending.op].safeParse(msg.result)
    if (!checked.success) {
      clearTimeout(pending.timer)
      this.protocolFailure("response result failed schema validation", pending)
      return
    }

    clearTimeout(pending.timer)
    this.protocolStreak = 0
    pending.resolve(checked.data)
  }

  private protocolFailure(message: string, victim?: PendingRequest): void {
    if (victim !== undefined) {
      victim.reject({ kind: "protocol", message })
    }
    this.protocolStreak += 1
    this.checkProtocolStreak(message)
  }

  /** Record a timed-out id so its late reply is dropped instead of counted. */
  private rememberLateReply(id: string): void {
    this.lateReplyIds.add(id)
    if (this.lateReplyIds.size > LATE_REPLY_RING) {
      const oldest = this.lateReplyIds.values().next().value
      if (oldest !== undefined) this.lateReplyIds.delete(oldest)
    }
  }

  private checkProtocolStreak(context?: string): void {
    if (this.protocolStreak >= 3 && !this.shuttingDown && !this.breakerOpen && this.proc !== null) {
      this.protocolStreak = 0
      // Three consecutive protocol failures: treat like a crash — kill the
      // child; the exit handler fails whatever is still in-flight and the
      // normal restart cycle takes over.
      console.error(
        `[rtk-client] killing server after repeated protocol failures${
          context ? ` (${context})` : ""
        }`
      )
      this.proc.kill("SIGKILL")
    }
  }

  private onChildExit(proc: RtkProc, code: number | null): void {
    if (this.proc !== proc) return // stale handler from a replaced child
    if (this.stalledTimer) clearTimeout(this.stalledTimer)
    this.stalledTimer = null
    this.proc = null
    this.inFlightId = null
    this.ready = false
    this.helloPid = null

    // The spawn caller owns handshake failure and its bounded child cleanup.
    // Scheduling here as well would create a second restart owner.
    if (this.shuttingDown || this.spawning) return

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject({ kind: "crash" })
    }
    this.pending.clear()

    console.error(
      `[rtk-client] rtk server (pid ${proc.pid}) exited with code ${code}; scheduling restart`
    )
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.breakerOpen || this.shuttingDown) return
    this.restartAttempt += 1
    if (this.restartAttempt > this.opts.maxRestartAttempts) {
      this.tripBreaker()
      return
    }
    const delay = RESTART_BACKOFF_MS * 2 ** (this.restartAttempt - 1)
    this.restartTimer = setTimeout(() => {
      void this.trySpawn().then((ok) => {
        if (!ok) this.scheduleRestart()
      })
    }, delay)
  }

  /** Attempt one spawn+handshake; true on success. Never throws. */
  private async trySpawn(): Promise<boolean> {
    if (this.shuttingDown || this.spawning || this.proc !== null) return this.proc !== null
    try {
      await this.spawnAndGreet()
      const wasBreaker = this.breakerOpen
      if (wasBreaker) {
        this.breakerOpen = false
        this.clearProbeTimer()
      }
      this.recoveries += 1
      console.error(
        `[rtk-client] rtk server ${wasBreaker ? "recovered (breaker closed)" : "restarted"} (pid ${
          this.helloPid
        })`
      )
      return true
    } catch {
      return false
    }
  }

  private tripBreaker(): void {
    this.breakerOpen = true
    this.restartAttempt = 0
    console.error(
      `[rtk-client] breaker OPEN after ${this.opts.maxRestartAttempts} failed restart(s); passthrough-only, probing every ${this.opts.probeIntervalMs}ms`
    )
    this.probeTimer = setInterval(() => {
      void this.trySpawn()
    }, this.opts.probeIntervalMs)
    this.probeTimer.unref?.()
  }

  private clearProbeTimer(): void {
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer)
      this.probeTimer = null
    }
  }

  private clearTimers(): void {
    if (this.stalledTimer !== null) {
      clearTimeout(this.stalledTimer)
      this.stalledTimer = null
    }
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.clearProbeTimer()
  }
}

/** Map a request() rejection to a wire DegradedReason; null = rethrow. */
function degradeFrom(err: unknown): DegradedReason | null {
  if (err instanceof RtkServerError) return null // caller bug, not transport
  if (typeof err === "object" && err !== null && "kind" in err) {
    switch ((err as PendingFailure).kind) {
      case "timeout":
        return "timeout"
      case "crash":
        return "crash"
      case "protocol":
        return "protocol"
      case "unready":
        return "spawn_failed"
      case "overloaded":
        return "overloaded"
    }
  }
  return null
}
