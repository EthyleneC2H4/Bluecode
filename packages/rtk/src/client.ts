/**
 * Plugin-side client for the rtk server subprocess.
 *
 * Owns the full degradation matrix at the process boundary:
 * - pre-warmed spawn at create() time (never on the per-request path)
 * - client-side fast path below minBytes (no IPC at all)
 * - serial request/response with id correlation and late-response discard
 * - per-request timeout -> passthrough "timeout" (child stays up)
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
} from "@bluecode/contracts";
import { bunSpawnArgv, createLineReconstructor, encodeFrame, newRequestId } from "@bluecode/shared";
import { DEFAULT_DATA_DIR } from "./engine";

export interface RtkClientOptions {
  /** Server entry file (default: this package's src/bin.ts). */
  entry?: string;
  /** Child working directory (default: inherit the caller's cwd). */
  cwd?: string;
  /** Compression token budget sent with compress ops. Default 512. */
  budgetTokens?: number;
  /** Per-request timeout. Default 40ms. */
  timeoutMs?: number;
  /** Outputs under this many bytes never reach the server. Default 512. */
  minBytes?: number;
  /** CAS root passed to the child as BLUECODE_DATA_DIR. Default <tmpdir>/bluecode-rtk. */
  dataDir?: string;
  /** Restart attempts before the breaker trips. Default 5. */
  maxRestartAttempts?: number;
  /** Breaker probe interval (spawn attempt). Default 30_000ms. */
  probeIntervalMs?: number;
  /** Run the child with BLUECODE_TEST=1 (test-only ops / delay hook). */
  testMode?: boolean;
  /**
   * Extra env vars merged over process.env for the child (tests inject
   * BLUECODE_TEST_DELAY_MS here without polluting their own environment).
   */
  serverEnv?: Record<string, string>;
}

const DEFAULTS = {
  budgetTokens: 512,
  timeoutMs: 40,
  minBytes: 512,
  maxRestartAttempts: 5,
  probeIntervalMs: 30_000,
} as const;

/** First restart backoff step; attempt n waits RESTART_BACKOFF_MS * 2^(n-1). */
const RESTART_BACKOFF_MS = 250;
/** Handshake budget for spawn/probe attempts. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** SIGTERM grace before a shutdown escalates to SIGKILL. */
const SHUTDOWN_GRACE_MS = 3_000;
/**
 * Generous default for the ops/debug surface (ping/stats): these are
 * liveness calls, not compression calls, so they may outlive the tight
 * compress/fetch timeout. Callers can pass a tighter budget explicitly.
 */
const OPS_TIMEOUT_MS = 10_000;

export type CompressOutcome =
  | { kind: "compressed"; result: CompressResult }
  | { kind: "passthrough"; output: string; degraded: DegradedReason | null };

export type FetchOutcome =
  | { kind: "found"; content: string }
  | { kind: "missing" }
  | { kind: "unavailable"; degraded: DegradedReason };

export interface CompressInput {
  tool: string;
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  callId?: string;
}

/** Well-formed ok:false response — a caller bug, not a transport failure. */
export class RtkServerError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(`rtk server error ${code}: ${message}`);
    this.name = "RtkServerError";
    this.code = code;
    this.detail = detail;
  }
}

/** Why an in-flight request gave up (mapped onto DegradedReason by callers). */
type PendingFailure =
  | { kind: "timeout" }
  | { kind: "crash" }
  | { kind: "protocol"; message: string }
  | { kind: "unready" };

interface PendingRequest {
  op: Exclude<RtkOp, "simulateCrash">;
  resolve: (result: unknown) => void;
  reject: (reason: PendingFailure | RtkServerError | Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClientDiag {
  /** Total spawn/handshake attempts (initial, restarts, probes). */
  spawns: number;
  /** Successful respawns after a down-period (restarts + breaker recovery). */
  recoveries: number;
  breakerOpen: boolean;
  /** Current restart attempt within one down-period (0 when healthy). */
  restartAttempt: number;
}

type RtkProc = import("bun").Subprocess<"pipe", "pipe", "pipe">;

/** Per-op result schemas — every incoming payload is checked against these. */
const RESULT_SCHEMAS = {
  compress: compressResultSchema,
  fetch: fetchResultSchema,
  ping: pingResultSchema,
  stats: statsResultSchema,
} as const;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the interpreter argv that runs a TS entry file.
 *
 * Lives in @bluecode/shared since the M7 compiled-host fix applies to every
 * sidecar spawn; re-exported here for API compatibility.
 */
export { bunSpawnArgv };

export class RtkClient {
  private readonly opts: {
    budgetTokens: number;
    timeoutMs: number;
    minBytes: number;
    maxRestartAttempts: number;
    probeIntervalMs: number;
    testMode: boolean;
    cwd: string | undefined;
    serverEnv: Record<string, string> | undefined;
  };
  private readonly entryPath: string;
  private readonly dataDir: string;

  private proc: RtkProc | null = null;
  private ready = false;
  private helloPid: number | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private spawning = false;
  private breakerOpen = false;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private protocolStreak = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private chainTail: Promise<void> = Promise.resolve();
  private spawns = 0;
  private recoveries = 0;

  private constructor(opts: RtkClientOptions) {
    this.opts = {
      budgetTokens: opts.budgetTokens ?? DEFAULTS.budgetTokens,
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      minBytes: opts.minBytes ?? DEFAULTS.minBytes,
      maxRestartAttempts: opts.maxRestartAttempts ?? DEFAULTS.maxRestartAttempts,
      probeIntervalMs: opts.probeIntervalMs ?? DEFAULTS.probeIntervalMs,
      testMode: opts.testMode ?? false,
      cwd: opts.cwd,
      serverEnv: opts.serverEnv,
    };
    // Sibling of this module: stable regardless of the caller's layout.
    this.entryPath = opts.entry ?? new URL("./bin.ts", import.meta.url).pathname;
    this.dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  }

  /**
   * Spawn the server and wait for its handshake now, so later requests are
   * pure IPC (the per-request path never spawns).
   */
  static async create(opts: RtkClientOptions = {}): Promise<RtkClient> {
    const client = new RtkClient(opts);
    await client.spawnAndGreet();
    return client;
  }

  // ------------------------------------------------------------------ info --

  /** pid from the live handshake; null while down/restarting/broken. */
  get serverPid(): number | null {
    return this.ready ? this.helloPid : null;
  }

  /** Introspection for tests and ops dashboards. */
  get diag(): ClientDiag {
    return {
      spawns: this.spawns,
      recoveries: this.recoveries,
      breakerOpen: this.breakerOpen,
      restartAttempt: this.restartAttempt,
    };
  }

  // ----------------------------------------------------------- public ops --

  async compress(input: CompressInput): Promise<CompressOutcome> {
    // Fast path: tiny outputs bypass the process boundary entirely.
    if (Buffer.byteLength(input.output, "utf8") < this.opts.minBytes) {
      return { kind: "passthrough", output: input.output, degraded: null };
    }

    const params: Record<string, unknown> = { tool: input.tool, output: input.output };
    if (input.title !== undefined) params.title = input.title;
    if (input.metadata !== undefined) params.metadata = input.metadata;
    if (input.sessionId !== undefined) params.sessionId = input.sessionId;
    if (input.callId !== undefined) params.callId = input.callId;
    params.budgetTokens = this.opts.budgetTokens;

    try {
      const result = compressResultSchema.parse(
        await this.request("compress", params, this.opts.timeoutMs),
      );
      return { kind: "compressed", result };
    } catch (err) {
      const degraded = degradeFrom(err);
      if (degraded === null) throw err;
      return { kind: "passthrough", output: input.output, degraded };
    }
  }

  async fetch(hash: string): Promise<FetchOutcome> {
    try {
      const result = fetchResultSchema.parse(
        await this.request("fetch", { hash }, this.opts.timeoutMs),
      );
      return result.found ? { kind: "found", content: result.content } : { kind: "missing" };
    } catch (err) {
      const degraded = degradeFrom(err);
      if (degraded === null) throw err;
      return { kind: "unavailable", degraded };
    }
  }

  /** Liveness check through the full IPC stack. Throws on transport failure. */
  async ping(timeoutMs: number = OPS_TIMEOUT_MS): Promise<PingResult> {
    const result = pingResultSchema.parse(await this.request("ping", {}, timeoutMs));
    return result;
  }

  /** Pipeline counters from the server. Throws on transport failure. */
  async stats(timeoutMs: number = OPS_TIMEOUT_MS): Promise<StatsResult> {
    const result = statsResultSchema.parse(await this.request("stats", {}, timeoutMs));
    return result;
  }

  /** Graceful close: SIGTERM, escalate to SIGKILL after the grace window. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearTimers();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("RtkClient is shutting down"));
    }
    this.pending.clear();

    const proc = this.proc;
    this.ready = false;
    this.proc = null;
    if (proc !== null) {
      proc.kill(); // SIGTERM
      const exited = proc.exited.then(() => undefined);
      const winner = await Promise.race([exited, sleep(SHUTDOWN_GRACE_MS).then(() => "grace" as const)]);
      if (winner === "grace") proc.kill("SIGKILL");
      await exited;
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
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("RtkClient is shut down"));
    }
    if (!this.ready || this.proc === null || this.breakerOpen || this.spawning) {
      // Down-window (restarting backoff or open breaker): fail fast instead
      // of queueing behind a spawn that may not succeed.
      return Promise.reject({ kind: "unready" } satisfies PendingFailure);
    }

    const id = newRequestId("rtk");
    const run = (): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        const proc = this.proc;
        if (proc === null || !this.ready || this.shuttingDown) {
          reject({ kind: "unready" } satisfies PendingFailure);
          return;
        }
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject({ kind: "timeout" } satisfies PendingFailure);
        }, timeoutMs);
        this.pending.set(id, { op, resolve, reject, timer });
        try {
          proc.stdin.write(encodeFrame({ v: PROTOCOL_VERSION, id, op, params }));
        } catch {
          // Broken pipe: the exit handler owns crash bookkeeping, but this
          // waiter must not hang until the timeout fires.
          clearTimeout(timer);
          this.pending.delete(id);
          reject({ kind: "crash" } satisfies PendingFailure);
        }
      });

    // Serial queue: at most one in-flight request at any time (matches the
    // server's serial loop and keeps late-response attribution trivial).
    return this.enqueueRequest(run);
  }

  private enqueueRequest<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chainTail.then(fn, fn);
    this.chainTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ------------------------------------------------------------- lifecycle --

  private async spawnAndGreet(): Promise<void> {
    this.spawning = true;
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        BLUECODE_DATA_DIR: this.dataDir,
        ...this.opts.serverEnv,
      };
      if (this.opts.testMode) env.BLUECODE_TEST = "1";

      const proc = Bun.spawn(bunSpawnArgv(this.entryPath), {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.opts.cwd ?? process.cwd(),
        env,
      }) as RtkProc;
      this.spawns += 1;
      this.proc = proc;

      const hello = deferred<{ proto: 1; pid: number }>();
      this.pumpStdout(proc, hello);
      this.pumpStderr(proc);

      proc.exited
        .then((code) => this.onChildExit(proc, code))
        .catch(() => {});

      const handshake = Promise.race([
        hello.promise,
        proc.exited.then(
          () => { throw new Error("rtk server exited during handshake"); },
        ),
        sleep(HANDSHAKE_TIMEOUT_MS).then(() => {
          throw new Error(`rtk server handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`);
        }),
      ]);
      try {
        const greeting = await handshake;
        this.helloPid = greeting.pid;
      } catch (err) {
        // Handshake failed: make sure the half-born child cannot linger.
        proc.kill();
        this.proc = null;
        throw err;
      }

      this.ready = true;
      this.restartAttempt = 0;
      this.protocolStreak = 0;
    } finally {
      this.spawning = false;
    }
  }

  private pumpStdout(proc: RtkProc, hello: { resolve: (v: { proto: 1; pid: number }) => void; reject: (e: unknown) => void }): void {
    void (async () => {
      const decoder = new TextDecoder();
      const frames = createLineReconstructor();
      let helloDone = false;
      try {
        for await (const chunk of proc.stdout) {
          const lines = frames.push(decoder.decode(chunk, { stream: true }));
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] as string;
            if (!helloDone && this.proc === proc) {
              helloDone = true;
              this.consumeHello(line, hello);
            } else {
              this.onFrame(line);
            }
          }
        }
        for (const line of frames.flush()) this.onFrame(line);
      } catch {
        // Stream died; the exited handler performs crash bookkeeping.
      }
    })();
  }

  private consumeHello(line: string, hello: { resolve: (v: { proto: 1; pid: number }) => void; reject: (e: unknown) => void }): void {
    try {
      hello.resolve(helloSchema.parse(JSON.parse(line)));
    } catch (err) {
      hello.reject(new Error(`rtk server sent an invalid handshake: ${String(err)}`));
    }
  }

  private pumpStderr(proc: RtkProc): void {
    void (async () => {
      const decoder = new TextDecoder();
      const frames = createLineReconstructor();
      try {
        for await (const chunk of proc.stderr) {
          for (const line of frames.push(decoder.decode(chunk, { stream: true }))) {
            console.error(`[rtk-server ${proc.pid}] ${line}`);
          }
        }
        for (const line of frames.flush()) console.error(`[rtk-server ${proc.pid}] ${line}`);
      } catch {
        // stderr is best effort.
      }
    })();
  }

  /** One stdout frame from the server (post-handshake). */
  private onFrame(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.protocolFailure("response frame is not valid JSON");
      return;
    }
    const envelope = responseSchema.safeParse(parsed);
    if (!envelope.success) {
      this.protocolFailure("response envelope failed schema validation");
      return;
    }
    const msg = envelope.data;

    if (msg.ok === false) {
      const pending = this.pending.get(msg.id);
      if (pending !== undefined) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.reject(new RtkServerError(msg.error.code, msg.error.message, msg.error.detail));
      }
      // Well-formed error responses are protocol traffic, not corruption.
      this.protocolStreak = 0;
      return;
    }

    const pending = this.pending.get(msg.id);
    if (pending === undefined) {
      // Late/duplicate response for an already-timed-out request: drop by id
      // so it can never be attributed to the next exchange.
      this.protocolStreak += 1;
      this.checkProtocolStreak();
      return;
    }

    const checked = RESULT_SCHEMAS[pending.op].safeParse(msg.result);
    if (!checked.success) {
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      this.protocolFailure("response result failed schema validation", pending);
      return;
    }

    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    this.protocolStreak = 0;
    pending.resolve(checked.data);
  }

  private protocolFailure(message: string, victim?: PendingRequest): void {
    if (victim !== undefined) {
      victim.reject({ kind: "protocol", message });
    }
    this.protocolStreak += 1;
    this.checkProtocolStreak(message);
  }

  private checkProtocolStreak(context?: string): void {
    if (this.protocolStreak >= 3 && !this.shuttingDown && !this.breakerOpen && this.proc !== null) {
      this.protocolStreak = 0;
      // Three consecutive protocol failures: treat like a crash — kill the
      // child; the exit handler fails whatever is still in-flight and the
      // normal restart cycle takes over.
      console.error(`[rtk-client] killing server after repeated protocol failures${context ? ` (${context})` : ""}`);
      this.proc.kill("SIGKILL");
    }
  }

  private onChildExit(proc: RtkProc, code: number | null): void {
    if (this.proc !== proc) return; // stale handler from a replaced child
    this.proc = null;
    this.ready = false;
    this.helloPid = null;

    if (this.shuttingDown) return;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject({ kind: "crash" });
    }
    this.pending.clear();

    console.error(`[rtk-client] rtk server (pid ${proc.pid}) exited with code ${code}; scheduling restart`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.breakerOpen || this.shuttingDown) return;
    this.restartAttempt += 1;
    if (this.restartAttempt > this.opts.maxRestartAttempts) {
      this.tripBreaker();
      return;
    }
    const delay = RESTART_BACKOFF_MS * 2 ** (this.restartAttempt - 1);
    this.restartTimer = setTimeout(() => {
      void this.trySpawn().then((ok) => {
        if (!ok) this.scheduleRestart();
      });
    }, delay);
  }

  /** Attempt one spawn+handshake; true on success. Never throws. */
  private async trySpawn(): Promise<boolean> {
    if (this.shuttingDown || this.spawning || this.proc !== null) return this.proc !== null;
    try {
      await this.spawnAndGreet();
      const wasBreaker = this.breakerOpen;
      if (wasBreaker) {
        this.breakerOpen = false;
        this.clearProbeTimer();
      }
      this.recoveries += 1;
      console.error(
        `[rtk-client] rtk server ${wasBreaker ? "recovered (breaker closed)" : "restarted"} (pid ${this.helloPid})`,
      );
      return true;
    } catch {
      return false;
    }
  }

  private tripBreaker(): void {
    this.breakerOpen = true;
    this.restartAttempt = 0;
    console.error(
      `[rtk-client] breaker OPEN after ${this.opts.maxRestartAttempts} failed restart(s); passthrough-only, probing every ${this.opts.probeIntervalMs}ms`,
    );
    this.probeTimer = setInterval(() => {
      void this.trySpawn();
    }, this.opts.probeIntervalMs);
    this.probeTimer.unref?.();
  }

  private clearProbeTimer(): void {
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearProbeTimer();
  }
}

/** Map a request() rejection to a wire DegradedReason; null = rethrow. */
function degradeFrom(err: unknown): DegradedReason | null {
  if (err instanceof RtkServerError) return null; // caller bug, not transport
  if (typeof err === "object" && err !== null && "kind" in err) {
    switch ((err as PendingFailure).kind) {
      case "timeout":
        return "timeout";
      case "crash":
        return "crash";
      case "protocol":
        return "protocol";
      case "unready":
        return "spawn_failed";
    }
  }
  return null;
}
