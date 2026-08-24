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
  healthResultSchema,
  type HeadroomCompressParams,
  type HeadroomCompressResult,
  type HeadroomRetrieveParams,
  type HeadroomRetrieveResult,
  type HealthResult,
} from "@bluecode/contracts";
import { newRequestId, createLineReconstructor, encodeFrame } from "@bluecode/shared";
import { retrieveByHashResultSchema, retrieveByQueryResultSchema } from "@bluecode/contracts";

export interface HeadroomClientOptions {
  /** Resolves socketPath as `<dataDir>/headroomd.sock` when socketPath is absent. */
  dataDir?: string;
  socketPath?: string;
  /** Recipe for launching a fresh daemon when the socket is not answering. */
  spawn?: { entry: string; cwd?: string };
  /** Per-request timeout. Default 5000ms. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const CONNECT_TIMEOUT_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

function defaultSocketPath(options: HeadroomClientOptions): string {
  if (options.socketPath !== undefined) return options.socketPath;
  if (options.dataDir !== undefined) return `${options.dataDir}/headroomd.sock`;
  throw new Error("headroomd client: needs socketPath or dataDir");
}

/** One connect attempt: attach, read the handshake line, hand back socket. */
function attemptConnect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const lines = createLineReconstructor();
    const decoder = new TextDecoder();
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("timeout", () => fail(new Error(`headroomd: connect timeout on ${socketPath}`)));
    socket.once("error", (err) => fail(err));
    socket.once("data", (chunk: Buffer) => {
      socket.setTimeout(0);
      const handshake = lines.push(decoder.decode(chunk, { stream: true }))[0];
      if (handshake === undefined) {
        fail(new Error("headroomd: empty handshake"));
        return;
      }
      try {
        const parsed = JSON.parse(handshake) as { proto?: unknown; pid?: unknown };
        if (parsed.proto !== 1 || typeof parsed.pid !== "number") {
          fail(new Error(`headroomd: bad handshake ${handshake}`));
          return;
        }
      } catch {
        fail(new Error(`headroomd: handshake not JSON: ${handshake}`));
        return;
      }
      // Re-queue the remainder (anything past the handshake line) so the
      // main reader does not lose it.
      const remainder = decoder.decode(chunk, { stream: true }).slice(handshake.length + 1);
      if (remainder.length > 0) socket.unshift(Buffer.from(remainder, "utf8"));
      resolve(socket);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HeadroomClient {
  private readonly socket: net.Socket;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lines = createLineReconstructor();
  private readonly decoder = new TextDecoder();
  private closed = false;

  private constructor(socket: net.Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.failAll(new Error("headroomd: connection error")));
    socket.on("close", () => this.failAll(new Error("headroomd: connection closed")));
  }

  /** Connect, spawning a daemon via `spawn` when the socket is dead. */
  static async connect(options: HeadroomClientOptions): Promise<HeadroomClient> {
    const socketPath = defaultSocketPath(options);
    const timeoutMs = options.timeoutMs ?? 5000;

    let connectError: unknown;
    try {
      const socket = await attemptConnect(socketPath);
      return new HeadroomClient(socket, timeoutMs);
    } catch (err) {
      if (options.spawn === undefined) {
        throw new Error(`headroomd: cannot connect to ${socketPath}: ${(err as Error).message}`);
      }
      connectError = err;
    }

    const child = Bun.spawn([process.execPath, "run", options.spawn.entry], {
      ...(options.spawn.cwd !== undefined ? { cwd: options.spawn.cwd } : {}),
      // Explicit pass-through: the daemon reads BLUECODE_DATA_DIR from here,
      // and relying on spawn's implicit env inheritance has proven flaky.
      env: { ...process.env } as Record<string, string>,
      stdout: "pipe", // boot handshake line, for spawn-side validation
      stderr: "pipe", // captured so boot failures are diagnosable
    });

    // Boot confirmation: one handshake line on stdout, bounded wait. Single
    // promise (not Promise.race) so no losing branch can reject later.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("headroomd: spawned daemon did not boot within 5s")),
        5000,
      );
      const decoder = new TextDecoder();
      let stderrText = "";
      const stderrReader = child.stderr.getReader();
      const drainStderr = (): void => {
        stderrReader.read().then(({ value, done }) => {
          if (done) return;
          stderrText += decoder.decode(value, { stream: true });
          if (stderrText.length < 4000) drainStderr();
        }, () => {});
      };
      drainStderr();
      const reader = child.stdout.getReader();
      reader.read().then(
        ({ value }) => {
          clearTimeout(timer);
          stderrReader.cancel().catch(() => {});
          const text = value === undefined ? "" : decoder.decode(value);
          if (!text.includes('"proto"')) {
            reject(
              new Error(
                `headroomd: spawned daemon printed no handshake line (stdout ${JSON.stringify(text)}; stderr ${JSON.stringify(stderrText.trim())})`,
              ),
            );
            return;
          }
          reader.cancel().catch(() => {});
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });

    // A long-lived daemon must not keep the plugin process alive on exit.
    if (typeof (child as { unref?: () => void }).unref === "function") child.unref();

    let lastError: unknown = connectError;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      await sleep(250 * 2 ** attempt);
      try {
        const socket = await attemptConnect(socketPath);
        return new HeadroomClient(socket, timeoutMs);
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
      if (typeof value === "object" && value !== null && "hits" in value) {
        return retrieveByQueryResultSchema.safeParse(value);
      }
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
      this.socket.write(encodeFrame({ v: 1, id, op, params }));
    }).then((value) => {
      const checked = validate(value);
      if (!checked.success) {
        throw new Error(`headroomd: ${op} result failed its wire schema`);
      }
      return checked.data as T;
    });
  }

  private onData(chunk: Buffer): void {
    for (const line of this.lines.push(this.decoder.decode(chunk, { stream: true }))) {
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
