/**
 * Unix-domain-socket JSONL daemon: handshake, framing, op dispatch, idle
 * exit, single-instance arbitration.
 *
 * Invariants (mirroring the rtk stdio server where applicable):
 * - The socket carries protocol frames only; diagnostics go to stderr.
 * - Requests are processed serially per client (per-connection promise
 chain); bun:sqlite serializes engine work globally anyway.
 * - One failing request never kills a connection: every failure path answers
 {ok:false,error:{code,message}} and keeps serving.
 * - Every outgoing frame is checked against headroomResponseSchema — an
 internal bug must not leak onto the wire as protocol damage.
 *
 * Single-instance discipline, in order:
 * 1. A matching live socket answers `already-running`; incompatible listeners
 * are preserved and rejected. Only a confirmed stale socket may be removed.
 * 2. The engine acquires an OS-backed SQLite writer lease for its storage root
 * before opening the store. A cold-start loser waits at most two seconds for
 * a v3 hello on its requested socket, then yields `already-running`. A writer
 * using another socket remains exclusive and the contender fails.
 * 3. UDS bind arbitrates ownership of the socket address independently of the
 * root writer lease. The pid file records the winner and is cleaned on exit.
 */
import net from "node:net"
import { existsSync } from "node:fs"
import { unlink, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import {
  ErrorCode,
  HEADROOM_PROTOCOL_VERSION,
  headroomCompressParamsSchema,
  headroomOpSchema,
  headroomResponseSchema,
  headroomRetrieveParamsSchema,
  healthParamsSchema,
  namespaceSchema,
  headroomCompressResultSchema,
  getCandidateParamsSchema,
  type HeadroomResponse,
  type ProtocolError,
} from "@bluecode/contracts"
import { createLineReconstructor, encodeFrame, FrameOverflowError } from "@bluecode/shared"
import { createEngine, type Engine } from "./engine"
import { attemptConnect } from "./client"
import { hardenPath } from "./perms"
import { HeadroomWriterBusyError } from "./store/lease"

export interface HeadroomServerOptions {
  dataDir: string
  maxStorageBytes?: number
  /** Defaults to `<dataDir>/headroomd.sock`. */
  socketPath?: string
  /** Idle exit after this many ms with zero clients and zero in-flight requests. 0 disables. Default 900_000. */
  idleExitMs?: number
  /** Honors responseDelayMs for timeout-path tests. Off in production. */
  testMode?: boolean
  /**
   * Artificial per-response latency for timeout-path tests. Honored only
   * when testMode is on; bin.ts sources it from BLUECODE_TEST_DELAY_MS.
   */
  responseDelayMs?: number
  /**
   * Per-client frame cap; headroom defaults to 8 MiB. Tests can lower the
   * limit to verify overflow handling without allocating large buffers.
   */
  maxFrameBytes?: number
}

export type HeadroomServerStart =
  | {
      status: "listening"
      readonly socketPath: string
      readonly pid: number
      /** Resolves once fully shut down (socket + pid file cleaned). */
      readonly done: Promise<void>
      /** Trigger graceful shutdown (tests; bin wires signals to this). */
      stop(): void
    }
  | { status: "already-running"; readonly socketPath: string }

/** Fallback id for frames too broken to yield one; responses need >=1 char. */
const UNKNOWN_ID = "?"

/**
 * Envelope pre-check: deliberately looser than headroomRequestSchema so an
 * unknown `op` can be answered E_UNKNOWN_OP instead of collapsing into
 * E_PROTOCOL.
 */
function parseEnvelope(
  value: unknown
): { v: number; id: string; op: string; params: unknown } | null {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  if (record.v !== HEADROOM_PROTOCOL_VERSION) return null
  if (typeof record.id !== "string" || record.id.length < 1) return null
  if (typeof record.op !== "string") return null
  return { v: HEADROOM_PROTOCOL_VERSION, id: record.id, op: record.op, params: record.params }
}

/**
 * Schema errors are duck-typed (ZodError instances carry an `issues` array).
 * Keeps zod a transitive-only dep of this package.
 */
function asParamIssueList(err: unknown): string[] | null {
  const issues = (err as { issues?: unknown } | null)?.issues
  if (!Array.isArray(issues)) return null
  return issues.map((issue) => {
    const i = issue as { path?: PropertyKey[]; message?: string }
    const joined = Array.isArray(i.path) ? i.path.join(".") : ""
    return joined.length > 0 ? `${joined}: ${i.message ?? "invalid"}` : i.message ?? "invalid"
  })
}

/** Probe whether a live daemon owns `socketPath` (connect + read handshake). */
function socketAlive(socketPath: string): Promise<boolean> {
  return attemptConnect(socketPath).then(
    ({ socket }) => {
      socket.destroy()
      return true
    },
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === "ECONNREFUSED" || code === "ENOENT") return false
      throw new Error(
        `Refusing to replace active or incompatible headroom socket: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  )
}

/** Bound the whole arbitration wait, including an incomplete hello. */
async function waitForWinningDaemon(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + 2000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        while (Date.now() < deadline) {
          if (await socketAlive(socketPath)) return true
          const remaining = deadline - Date.now()
          if (remaining > 0)
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
        }
        return false
      })(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function log(message: string): void {
  if (!process.stderr.destroyed) process.stderr.write(`[headroomd] ${message}\n`, () => {})
}

export async function startHeadroomServer(
  options: HeadroomServerOptions
): Promise<HeadroomServerStart> {
  if (existsSync(path.join(options.dataDir, "storage-v2", ".headroom-migration.lock")))
    throw new Error("Headroom offline migration is in progress")
  const startedAtMs = Date.now()
  const socketPath = options.socketPath ?? path.join(options.dataDir, "headroomd.sock")
  const pidPath = path.join(options.dataDir, "headroomd.pid")

  // ---- single-instance arbitration ---------------------------------------
  if (existsSync(socketPath) && (await socketAlive(socketPath))) {
    return { status: "already-running", socketPath }
  }
  if (existsSync(socketPath)) await unlink(socketPath).catch(() => {})

  await mkdir(options.dataDir, { recursive: true })
  await mkdir(path.dirname(socketPath), { recursive: true })
  let engine: Engine
  try {
    engine = await createEngine({
      dataDir: path.join(options.dataDir, "storage-v2", "headroom"),
      ...(options.maxStorageBytes !== undefined
        ? { maxStorageBytes: options.maxStorageBytes }
        : {}),
    })
  } catch (error) {
    if (error instanceof HeadroomWriterBusyError && (await waitForWinningDaemon(socketPath))) {
      return { status: "already-running", socketPath }
    }
    throw error
  }

  const idleExitMs = options.idleExitMs ?? 900_000
  const responseDelayMs = options.testMode === true ? Math.max(0, options.responseDelayMs ?? 0) : 0

  let clients = 0
  let activeRequests = 0
  let admittedRequests = 0,
    admittedBytes = 0
  const operations = new Set<Promise<void>>()
  let stopped = false
  const openClients = new Set<net.Socket>()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let releaseDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    releaseDone = resolve
  })

  function armIdleTimer(): void {
    if (stopped || idleExitMs <= 0) return
    if (clients > 0 || activeRequests > 0) return
    disarmIdleTimer()
    idleTimer = setTimeout(() => {
      log(`idle for ${idleExitMs}ms with no clients; exiting`)
      shutdown()
    }, idleExitMs)
  }

  function disarmIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function frameFor(frame: unknown): string {
    return encodeFrame(frame)
  }

  /** Validate then write one response frame. Never throws past a log. */
  function respond(client: net.Socket, response: HeadroomResponse): void {
    const checked = headroomResponseSchema.safeParse(response)
    if (!checked.success) {
      log("internal bug: outgoing frame failed headroomResponseSchema")
      client.write(
        frameFor({
          v: HEADROOM_PROTOCOL_VERSION,
          id: UNKNOWN_ID,
          ok: false,
          error: { code: ErrorCode.E_INTERNAL, message: "outgoing frame failed schema" },
        })
      )
      return
    }
    const frame = frameFor(checked.data)
    if (responseDelayMs > 0) {
      setTimeout(() => client.writable && client.write(frame), responseDelayMs)
      return
    }
    if (!client.writable || client.destroyed) return
    if (client.writableLength + Buffer.byteLength(frame) > 8 * 1024 * 1024) {
      client.destroy()
      return
    }
    if (!client.write(frame)) {
      client.pause()
      const timer = setTimeout(() => client.destroy(), 1000)
      client.once("drain", () => {
        clearTimeout(timer)
        if (!stopped) client.resume()
      })
      client.once("close", () => clearTimeout(timer))
    }
  }

  /**
   * Dispatch one request against the engine. Returns the exact response to
   * write (ok or structured error) — pure orchestration, no I/O surprises.
   */
  async function handleRequest(
    id: string,
    op: string,
    rawParams: unknown
  ): Promise<HeadroomResponse> {
    const knownOp = headroomOpSchema.safeParse(op)
    if (!knownOp.success) {
      return {
        v: HEADROOM_PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code: ErrorCode.E_UNKNOWN_OP, message: `unknown op ${JSON.stringify(op)}` },
      }
    }

    try {
      switch (knownOp.data) {
        case "getCandidate":
          return { v: HEADROOM_PROTOCOL_VERSION, id, ok: true, result: await engine.getCandidate(getCandidateParamsSchema.parse(rawParams)) }
        case "view.get":
          return {
            v: HEADROOM_PROTOCOL_VERSION,
            id,
            ok: true,
            result: engine.getView(namespaceSchema.parse(rawParams)),
          }
        case "view.clear": {
          engine.clearView(namespaceSchema.parse(rawParams))
          return { v: HEADROOM_PROTOCOL_VERSION, id, ok: true, result: null }
        }
        case "view.set": {
          const value = rawParams as { namespace?: unknown; plan?: unknown } | null
          engine.setView(
            namespaceSchema.parse(value?.namespace),
            headroomCompressResultSchema.parse(value?.plan)
          )
          return { v: HEADROOM_PROTOCOL_VERSION, id, ok: true, result: null }
        }
        case "compress": {
          const params = headroomCompressParamsSchema.parse(rawParams)
          return {
            v: HEADROOM_PROTOCOL_VERSION,
            id,
            ok: true,
            result: await engine.compress(params),
          }
        }
        case "retrieve": {
          const params = headroomRetrieveParamsSchema.parse(rawParams)
          return {
            v: HEADROOM_PROTOCOL_VERSION,
            id,
            ok: true,
            result: await engine.retrieve(params),
          }
        }
        case "health": {
          healthParamsSchema.parse(rawParams)
          return {
            v: HEADROOM_PROTOCOL_VERSION,
            id,
            ok: true,
            result: {
              ok: true as const,
              pid: process.pid,
              uptimeMs: Date.now() - startedAtMs,
              sessions: engine.sessionCount(),
            },
          }
        }
      }
    } catch (err) {
      const issues = asParamIssueList(err)
      if (issues !== null) {
        return {
          v: HEADROOM_PROTOCOL_VERSION,
          id,
          ok: false,
          error: {
            code: ErrorCode.E_INVALID_PARAMS,
            message: "params failed schema validation",
            detail: issues,
          },
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      log(`op ${knownOp.data} failed: ${message}`)
      return {
        v: HEADROOM_PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code: ErrorCode.E_INTERNAL, message },
      }
    }
  }

  async function handleLine(client: net.Socket, line: string): Promise<void> {
    if (line.trim().length === 0) {
      respond(client, {
        v: HEADROOM_PROTOCOL_VERSION,
        id: UNKNOWN_ID,
        ok: false,
        error: { code: ErrorCode.E_PROTOCOL, message: "empty line is not a valid frame" },
      })
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      respond(client, {
        v: HEADROOM_PROTOCOL_VERSION,
        id: UNKNOWN_ID,
        ok: false,
        error: { code: ErrorCode.E_PROTOCOL, message: "frame is not valid JSON" },
      })
      return
    }

    const envelope = parseEnvelope(parsed)
    if (envelope === null) {
      respond(client, {
        v: HEADROOM_PROTOCOL_VERSION,
        id: UNKNOWN_ID,
        ok: false,
        error: {
          code: ErrorCode.E_PROTOCOL,
          message: `malformed request envelope (expected {v:${HEADROOM_PROTOCOL_VERSION},id,op,params})`,
        },
      })
      return
    }

    activeRequests += 1
    disarmIdleTimer()
    try {
      const response = await handleRequest(envelope.id, envelope.op, envelope.params)
      respond(client, response)
    } finally {
      activeRequests -= 1
      armIdleTimer()
    }
  }

  const server = net.createServer((client) => {
    if (stopped || openClients.size >= 32) {
      client.destroy()
      return
    }
    clients += 1
    openClients.add(client)
    disarmIdleTimer()
    // Handshake first, always: {"proto":3,"pid":<pid>}
    client.write(frameFor({ proto: HEADROOM_PROTOCOL_VERSION, pid: process.pid }))

    const lines = createLineReconstructor(
      // exactOptionalPropertyTypes: stay absent rather than undefined.
      { maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024 }
    )
    const decoder = new TextDecoder()
    // Serialize per connection so one client's responses keep arrival order.
    let tail: Promise<void> = Promise.resolve()

    client.on("data", (chunk: Buffer) => {
      if (stopped) return
      try {
        for (const line of lines.push(decoder.decode(chunk, { stream: true }))) {
          const bytes = Buffer.byteLength(line)
          if (admittedRequests >= 32 || admittedBytes + bytes > 8 * 1024 * 1024) {
            client.destroy()
            break
          }
          admittedRequests++
          admittedBytes += bytes
          const operation = tail
            .then(() => handleLine(client, line))
            .catch(() => {})
            .finally(() => {
              admittedRequests--
              admittedBytes -= bytes
              operations.delete(operation)
            })
          tail = operation
          operations.add(operation)
        }
      } catch (err) {
        if (!(err instanceof FrameOverflowError)) throw err
        // A frame past the cap means the sender has already blown the framing
        // contract; the reconstructor dropped its partial buffer, so frame
        // boundaries can no longer be trusted. Answer best-effort — the
        // socket may not accept writes anymore — then destroy. Logged with
        // the cap so floods classify distinctly from ordinary E_PROTOCOLs.
        log(`frame overflow past ${err.maxFrameBytes} bytes: destroying client`)
        respond(client, {
          v: HEADROOM_PROTOCOL_VERSION,
          id: UNKNOWN_ID,
          ok: false,
          error: {
            code: ErrorCode.E_PROTOCOL,
            message: `frame exceeded ${err.maxFrameBytes} bytes without a newline`,
          },
        })
        client.destroy()
      }
    })
    client.on("error", () => {}) // ECONNRESET etc. — handled by close
    client.on("close", () => {
      openClients.delete(client)
      clients -= 1
      armIdleTimer()
    })
  })

  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })

  try {
    await listening
  } catch (err) {
    engine.close()
    // Losing the probe/bind race (a twin bound between our probe and our
    // bind) is expected: re-probe once and defer to the winner instead of
    // making spawn callers watch a crash.
    if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE" && (await socketAlive(socketPath))) {
      return { status: "already-running", socketPath }
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`headroomd: cannot bind ${socketPath}: ${message}`)
  }

  await writeFile(pidPath, String(process.pid), "utf8")
  // Cross-account hardening: 0600 on the socket means only the daemon owner
  // can attach (and only the owner could have bound/squatted this path).
  // Complements the uid-namespaced default dirs in @bluecode/shared — the
  // plugin may hand us an explicit dataDir, so chmod regardless. macOS
  // tmpdir is already per-user; this closes Linux /tmp vectors regardless of
  // umask. Best-effort (see hardenPath): a failed chmod warns and continues
  // rather than crashing a daemon that is already listening.
  hardenPath(socketPath, 0o600)
  armIdleTimer() // born idle: exit timer starts with zero clients

  function shutdown(): void {
    if (stopped) return
    stopped = true
    disarmIdleTimer()
    server.close(() => {})
    for (const client of openClients) client.pause()
    void (async () => {
      await Promise.allSettled([...operations])
      for (const client of openClients) client.destroy()
      engine.close()
      await Promise.allSettled([unlink(socketPath), unlink(pidPath)])
      releaseDone()
    })()
  }

  return {
    status: "listening",
    socketPath,
    pid: process.pid,
    done,
    stop: shutdown,
  }
}
