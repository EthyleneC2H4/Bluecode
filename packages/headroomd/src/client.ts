/**
 * HeadroomClient — the ONLY entry point M5 (the opencode plugin) uses.
 *
 * connect() tries the socket first (≤1000ms); on failure and when a spawn
 * recipe is given, it launches `bun run <entry>` and reconnects with
 * exponential backoff (250ms × 2^n, 5 attempts max) before giving up — the
 * caller (plugin) degrades gracefully on throw.
 *
 * Request/response correlation is by frame id; each request has its own
 * timeout (default 5000ms) and a late response is dropped (its id was
 * already retired). A connection loss rejects every in-flight request; the
 * client does NOT auto-reconnect afterwards — the plugin owns the watchdog
 * policy and simply builds a fresh client.
 */
import net from "node:net";
import {
  headroomCompressResultSchema,
  headroomResponseSchema,
  HEADROOM_PROTOCOL_VERSION,
  healthResultSchema,
  type HeadroomCompressParams,
  type HeadroomCompressResult,
  type HeadroomRetrieveParams,
  type HeadroomRetrieveResult,
  type HealthResult,
} from "@bluecode/contracts";
import {
  bunSpawnArgv,
  createLineReconstructor,
  encodeFrame,
  FrameOverflowError,
  newRequestId,
} from "@bluecode/shared";
import {
  retrieveByHashResultSchema,
  retrieveByHistoryResultSchema,
  retrieveByQueryResultSchema,
} from "@bluecode/contracts";

export interface HeadroomClientOptions {
  /** Resolves socketPath as `<dataDir>/headroomd.sock` when socketPath is absent. */
  dataDir?: string;
  socketPath?: string;
  /** Recipe for launching a fresh daemon when the socket is not answering. */
  spawn?: { entry: string; cwd?: string; args?: string[] };
  /** Per-request timeout. Default 5000ms. */
  timeoutMs?: number;
  /**
   * Frame cap fed to the line reconstructor (shared default: 64 MiB). Exposing
   * it lets flood-hardening be unit-tested without 64 MiB buffers.
   */
  maxFrameBytes?: number;
}

/**
 * Pure seam over the spawn recipe so tests can pin the exact argv without
 * launching anything. Interpreter choice is delegated to bunSpawnArgv because
 * process.execPath is NOT a script runner inside compiled hosts (M7 real
 * smoke / devlog #32: opencode embeds bun; execPath there is the host binary
 * and `[hostBinary, "run", entry]` never boots a daemon). Caller args are
 * appended after the interpreter pair.
 */
export function daemonSpawnArgv(
  spawn: { entry: string; args?: string[] },
  execPath: string = process.execPath,
): string[] {
  return [...bunSpawnArgv(spawn.entry, execPath), ...(spawn.args ?? [])];
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const CONNECT_TIMEOUT_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
/**
 * A real daemon's handshake is one short JSON line; anything near this size
 * without a newline is not speaking our protocol. Caps the pre-handshake
 * accumulator so a rogue listener on the socket path cannot grow client
 * memory without bound while the timeout clock runs.
 */
const MAX_HANDSHAKE_BYTES = 64 * 1024;

function defaultSocketPath(options: HeadroomClientOptions): string {
  if (options.socketPath !== undefined) return options.socketPath;
  if (options.dataDir !== undefined) return `${options.dataDir}/headroomd.sock`;
  throw new Error("headroomd client: needs socketPath or dataDir");
}

/** Result of one connect attempt: the live socket plus unconsumed bytes. */
export interface AttemptedConnection {
  readonly socket: net.Socket;
  /**
   * Bytes received past the handshake line that no reader has seen yet. The
   * consumer MUST feed these into its frame pipeline before awaiting more
   * data. Handed back explicitly instead of socket.unshift(): Bun drops
   * unshifted bytes whenever the real reader attaches outside the same emit
   * tick (verified on Bun 1.4), so re-emission cannot be relied on here.
   */
  readonly pending: Buffer;
}

/**
 * One connect attempt: attach, read the handshake line, hand back socket.
 *
 * Byte-level framing (audit fix): the old single-"data"-event version
 * hard-failed "empty handshake" when the first chunk carried an incomplete
 * line and double-decoded the same chunk, losing buffered bytes. Here bytes
 * accumulate until a LF exists; ONLY the handshake byte range is decoded for
 * JSON validation (a chunk boundary can never split a multibyte UTF-8 char
 * mid-handshake), and any remainder travels out via `.pending`. The 1000ms
 * timeout remains the bound while waiting across chunks.
 */
export function attemptConnect(socketPath: string): Promise<AttemptedConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let acc: Buffer = Buffer.alloc(0);
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    // Named so it can be removed before resolve — the HeadroomClient
    // constructor attaches its own data listener, and leaving this one
    // attached would deliver every later frame twice.
    const handler = (chunk: Buffer): void => {
      acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
      const nl = acc.indexOf(0x0a);
      if (nl === -1) {
        // The accumulator used to be unbounded while the timeout clock ran.
        if (acc.length > MAX_HANDSHAKE_BYTES) {
          fail(
            new Error(
              `headroomd: handshake exceeded ${MAX_HANDSHAKE_BYTES} bytes without a newline`,
            ),
          );
        }
        return; // keep waiting; CONNECT_TIMEOUT_MS is the bound
      }
      const handshakeBytes = acc.subarray(0, nl);
      const rest = acc.subarray(nl + 1);
      let handshake = "";
      try {
        handshake = handshakeBytes.toString("utf8"); // trailing \r is JSON whitespace
        const parsed = JSON.parse(handshake) as { proto?: unknown; pid?: unknown };
        if (parsed.proto !== HEADROOM_PROTOCOL_VERSION || typeof parsed.pid !== "number") {
          fail(new Error(`headroomd: bad handshake ${handshake}`));
          return;
        }
      } catch {
        fail(new Error(`headroomd: handshake not JSON: ${handshake}`));
        return;
      }
      socket.setTimeout(0);
      socket.removeListener("data", handler);
      resolve({ socket, pending: rest });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("timeout", () => fail(new Error(`headroomd: connect timeout on ${socketPath}`)));
    socket.once("error", (err) => fail(err));
    socket.on("data", handler);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HeadroomClient {
  private readonly socket: net.Socket;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lines: ReturnType<typeof createLineReconstructor>;
  private readonly decoder = new TextDecoder();
  private closed = false;

  private constructor(
    socket: net.Socket,
    timeoutMs: number,
    maxFrameBytes?: number,
    pendingBytes?: Buffer,
  ) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.lines = createLineReconstructor(
      // exactOptionalPropertyTypes: stay absent rather than undefined.
      ...(maxFrameBytes !== undefined ? [{ maxFrameBytes }] : []),
    );
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.failAll(new Error("headroomd: connection error")));
    socket.on("close", () => this.failAll(new Error("headroomd: connection closed")));
    // attemptConnect may have already pulled in response frames riding behind
    // the handshake. Feed them synchronously BEFORE any queued event can
    // fire — single-threaded delivery keeps wire order intact.
    if (pendingBytes !== undefined && pendingBytes.length > 0) this.onData(pendingBytes);
  }

  /** Connect, spawning a daemon via `spawn` when the socket is dead. */
  static async connect(options: HeadroomClientOptions): Promise<HeadroomClient> {
    const socketPath = defaultSocketPath(options);
    const timeoutMs = options.timeoutMs ?? 5000;

    let connectError: unknown;
    try {
      const { socket, pending } = await attemptConnect(socketPath);
      return new HeadroomClient(socket, timeoutMs, options.maxFrameBytes, pending);
    } catch (err) {
      if (options.spawn === undefined) {
        throw new Error(`headroomd: cannot connect to ${socketPath}: ${(err as Error).message}`);
      }
      connectError = err;
    }

    // bunSpawnArgv, not [execPath, "run", entry]: inside a compiled host the
    // execPath is the host binary, which never boots a daemon (M7 real smoke /
    // devlog #32 — rtk hit the identical trap). Caller args ride along.
    const child = Bun.spawn(daemonSpawnArgv(options.spawn), {
      ...(options.spawn.cwd !== undefined ? { cwd: options.spawn.cwd } : {}),
      // Explicit pass-through: the daemon reads BLUECODE_DATA_DIR from here,
      // and relying on spawn's implicit env inheritance has proven flaky.
      env: { ...process.env } as Record<string, string>,
      stdout: "pipe", // boot handshake line, for spawn-side validation
      stderr: "pipe", // captured so boot failures are diagnosable
    });

    // Boot confirmation: one handshake line on stdout, bounded wait. Single
    // promise (not Promise.race) with a settled guard so no losing branch can
    // settle later, and every rejection funnels through fail(): timer cleared,
    // half-born child SIGTERMed (bin.ts maps SIGTERM to graceful stop, which
    // removes socket/pid artifacts; SIGKILL would strand them), event-loop ref
    // released so a dying child cannot pin the plugin process. The old version
    // leaked the child and abandoned its readers on exactly these paths.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      function fail(err: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill(); // default SIGTERM on purpose — see comment above
        if (typeof (child as { unref?: () => void }).unref === "function") child.unref();
        reject(err);
      }
      const timer: ReturnType<typeof setTimeout> = setTimeout(
        () => fail(new Error("headroomd: spawned daemon did not boot within 5s")),
        5000,
      );
      const decoder = new TextDecoder();
      let stderrText = "";
      // The drain loop runs UNCONDITIONALLY and never cancels: cancel()'s
      // fd-release behavior varies across Bun versions, and an undrained pipe
      // blocks a chatty daemon mid-write forever (a live daemon must never sit
      // on a full stderr pipe). Only accumulation is capped — it exists for
      // boot diagnostics alone; after the cap every chunk is read and dropped.
      const stderrReader = child.stderr.getReader();
      const drainStderr = (): void => {
        stderrReader.read().then(({ value, done }) => {
          if (done) return;
          if (stderrText.length < 4000) stderrText += decoder.decode(value, { stream: true });
          drainStderr();
        }, () => {});
      };
      drainStderr();
      const reader = child.stdout.getReader();
      reader.read().then(
        ({ value }) => {
          const text = value === undefined ? "" : decoder.decode(value);
          if (!text.includes('"proto"')) {
            fail(
              new Error(
                `headroomd: spawned daemon printed no handshake line (stdout ${JSON.stringify(text)}; stderr ${JSON.stringify(stderrText.trim())})`,
              ),
            );
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reader.cancel().catch(() => {});
          resolve();
        },
        (err: unknown) => {
          fail(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });

    // A long-lived daemon must not keep the plugin process alive on exit.
    if (typeof (child as { unref?: () => void }).unref === "function") child.unref();

    let lastError: unknown = connectError;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      await sleep(250 * 2 ** attempt);
      try {
        const { socket, pending } = await attemptConnect(socketPath);
        return new HeadroomClient(socket, timeoutMs, options.maxFrameBytes, pending);
      } catch (err) {
        lastError = err;
      }
    }
    child.kill();
    throw new Error(
      `headroomd: daemon at ${socketPath} unreachable after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts: ` +
        `${(lastError as Error)?.message ?? "unknown"}`,
    );
  }

  compress(params: HeadroomCompressParams): Promise<HeadroomCompressResult> {
    return this.request(
      "compress",
      params,
      (value) => headroomCompressResultSchema.safeParse(value),
    );
  }

  retrieve(params: HeadroomRetrieveParams): Promise<HeadroomRetrieveResult> {
    // Result shape depends on the mode; validate against the matching member.
    return this.request("retrieve", params, (value) => {
      if ("query" in params) return retrieveByQueryResultSchema.safeParse(value);
      if ("historyHash" in params) return retrieveByHistoryResultSchema.safeParse(value);
      return retrieveByHashResultSchema.safeParse(value);
    });
  }

  health(): Promise<HealthResult> {
    return this.request("health", {}, (value) => healthResultSchema.safeParse(value));
  }

  /** Graceful close: in-flight requests were rejected by the close event. */
  close(): Promise<void> {
    this.closed = true;
    // A socket the daemon already tore down has fired (or will never fire)
    // its 'close' event — waiting on it here would hang forever.
    if (this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.end();
    });
  }

  private request<T>(
    op: string,
    params: unknown,
    validate: (value: unknown) => { success: boolean; data?: unknown; error?: unknown },
  ): Promise<T> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error("headroomd: client is closed"));
    }
    const id = newRequestId("hm");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Retire the id: a late response finds no pending entry and is dropped.
        this.pending.delete(id);
        reject(new Error(`headroomd: ${op} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.socket.write(encodeFrame({ v: HEADROOM_PROTOCOL_VERSION, id, op, params }));
    }).then((value) => {
      const checked = validate(value);
      if (!checked.success) {
        throw new Error(`headroomd: ${op} result failed its wire schema`);
      }
      return checked.data as T;
    });
  }

  private onData(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.lines.push(this.decoder.decode(chunk, { stream: true }));
    } catch (err) {
      // Frame overflow is unrecoverable protocol damage: the reconstructor
      // already dropped the partial frame, so frame boundaries can no longer
      // be trusted — fail every in-flight request with the SPECIFIC error
      // (distinctly classified in logs as FrameOverflowError + cap) and tear
      // the socket down instead of letting generic "connection closed" mask it.
      this.socket.destroy();
      this.failAll(err instanceof FrameOverflowError ? err : new Error(String(err)));
      return;
    }
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // never a valid response; drop
      }
      const checked = headroomResponseSchema.safeParse(parsed);
      if (!checked.success) continue; // protocol damage: drop, don't crash
      const pending = this.pending.get(checked.data.id);
      if (pending === undefined) continue; // late frame after timeout: drop
      this.pending.delete(checked.data.id);
      clearTimeout(pending.timer);
      if (checked.data.ok) {
        pending.resolve(checked.data.result);
      } else {
        const { code, message } = checked.data.error;
        pending.reject(new Error(`headroomd ${code}: ${message}`));
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
