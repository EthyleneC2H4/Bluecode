/**
 * Daemon-level integration: UDS handshake, full-chain ops over the socket,
 * error-path resilience, single-instance arbitration, and idle exit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage } from "@bluecode/contracts";
import { startHeadroomServer } from "../src/server";

const dirs: string[] = [];
const stops: Array<() => void> = [];

afterAll(async () => {
  for (const stop of stops) stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bluecode-hd-srv-"));
  dirs.push(dir);
  return dir;
}

function user(id: string, text: string): ChatMessage {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

interface RawClient {
  pid: number;
  /** Underlying socket, for asserting server-initiated teardown. */
  socket: net.Socket;
  sendRaw(text: string): void;
  /** Send one request frame; resolve on the response carrying its id. */
  roundtrip(value: unknown, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Resolve on the NEXT response frame regardless of id (error frames use UNKNOWN_ID). */
  nextResponse(timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

/** Minimal protocol participant for asserting on raw frames. */
function rawConnect(socketPath: string): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    let handshaken = false;
    const byId = new Map<string, (frame: Record<string, unknown>) => void>();
    const anyWaiters: Array<(frame: Record<string, unknown>) => void> = [];
    const queue: Record<string, unknown>[] = [];
    let seq = 0;

    const dispatch = (frame: Record<string, unknown>): void => {
      const waiter = byId.get(frame.id as string);
      if (waiter !== undefined) {
        byId.delete(frame.id as string);
        waiter(frame);
        return;
      }
      const any = anyWaiters.shift();
      if (any !== undefined) any(frame);
      else queue.push(frame);
    };

    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        // First frame is the daemon handshake {"proto":1,"pid":N}.
        if (!handshaken && typeof frame.pid === "number") {
          handshaken = true;
          resolve({
            pid: frame.pid,
            socket,
            sendRaw: (text) => socket.write(text),
            roundtrip: (value, timeoutMs = 2000) =>
              new Promise((res, rej) => {
                const id = `t${++seq}`;
                const timer = setTimeout(() => rej(new Error("raw roundtrip timeout")), timeoutMs);
                byId.set(id, (response) => {
                  clearTimeout(timer);
                  res(response);
                });
                socket.write(`${JSON.stringify({ ...(value as object), id })}\n`);
              }),
            nextResponse: (timeoutMs = 2000) =>
              new Promise((res, rej) => {
                const queued = queue.shift();
                if (queued !== undefined) {
                  res(queued as Record<string, unknown>);
                  return;
                }
                const timer = setTimeout(() => rej(new Error("no response arrived")), timeoutMs);
                anyWaiters.push((frame) => {
                  clearTimeout(timer);
                  res(frame);
                });
              }),
            close: () => socket.destroy(),
          });
          continue;
        }
        dispatch(frame);
      }
    });
    setTimeout(() => reject(new Error("rawConnect timeout")), 2000).unref();
  });
}

describe("socket protocol", () => {
  test("handshake, full-chain ops, and error resilience", async () => {
    const dir = await freshDir();
    const started = await startHeadroomServer({ dataDir: dir });
    if (started.status !== "listening") throw new Error("expected listening");
    stops.push(started.stop);

    const client = await rawConnect(started.socketPath);

    // compress over the wire
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 4; i++) {
      messages.push(
        user(
          `u${i}`,
          `第 ${i} 轮问题：分析模块 alpha。${"逐项检查输入、状态转换、恢复路径和异常边界。".repeat(16)}`,
        ),
      );
    }
    const compressed = await client.roundtrip({
      v: 1,
      op: "compress",
      params: { sessionId: "s1", projectId: "p1", contextWindowTokens: 100_000, messages, retainRecentTurns: 2 },
    });
    expect(compressed.ok).toBe(true);
    const result = compressed.result as Record<string, unknown>;
    expect(result.compacted).toBe(true);
    expect(result.replacedMessageIds).toEqual(["u0", "u1"]);

    // retrieve by hash over the wire
    const refs = result.refs as Array<{ contentHash: string }>;
    const fetched = await client.roundtrip({
      v: 1,
      op: "retrieve",
      params: { namespace: { projectId: "p1", sessionId: "s1" }, hash: refs[0]!.contentHash },
    });
    expect(fetched.ok).toBe(true);
    expect(fetched.result).toMatchObject({ found: true });

    // health over the wire
    const health = await client.roundtrip({ v: 1, op: "health", params: {} });
    expect(health.result).toMatchObject({ ok: true, sessions: 1 });

    // unknown op -> E_UNKNOWN_OP
    const unknown = await client.roundtrip({ v: 1, op: "teleport", params: {} });
    expect(unknown.ok).toBe(false);
    expect((unknown.error as Record<string, unknown>).code).toBe("E_UNKNOWN_OP");

    // malformed JSON -> E_PROTOCOL (reply carries UNKNOWN_ID)
    client.sendRaw("{not json\n");
    const protocolError = await client.nextResponse();
    expect(protocolError.ok).toBe(false);
    expect((protocolError.error as Record<string, unknown>).code).toBe("E_PROTOCOL");

    // invalid params -> E_INVALID_PARAMS
    const invalid = await client.roundtrip({ v: 1, op: "compress", params: { nope: 1 } });
    expect(invalid.ok).toBe(false);
    expect((invalid.error as Record<string, unknown>).code).toBe("E_INVALID_PARAMS");

    // The loop survived everything above.
    const stillAlive = await client.roundtrip({ v: 1, op: "health", params: {} });
    expect(stillAlive.ok).toBe(true);

    client.close();
  });

  test("second instance yields already-running; dead socket is rebound", async () => {
    const dir = await freshDir();
    const first = await startHeadroomServer({ dataDir: dir });
    if (first.status !== "listening") throw new Error("expected listening");
    stops.push(first.stop);

    const second = await startHeadroomServer({ dataDir: dir });
    expect(second.status).toBe("already-running");
    if (second.status === "already-running") {
      expect(second.socketPath).toBe(first.socketPath);
    }

    // A dead socket file is unlinked and rebound, not reported as running.
    first.stop();
    for (let i = 0; i < 50 && existsSync(first.socketPath); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const revived = await startHeadroomServer({ dataDir: dir });
    expect(revived.status).toBe("listening");
    if (revived.status === "listening") stops.push(revived.stop);
  });

  test("idle exit removes socket and pid files", async () => {
    const dir = await freshDir();
    const started = await startHeadroomServer({ dataDir: dir, idleExitMs: 300 });

    if (started.status !== "listening") throw new Error("expected listening");
    await Promise.race([
      started.done,
      new Promise((_, rej) => setTimeout(() => rej(new Error("idle exit never fired")), 5000)),
    ]);
    // Poll until BOTH artifacts are gone: shutdown unlinks them in sequence,
    // so the socket may vanish a tick before the pid file does.
    const clean = () => !existsSync(started.socketPath) && !existsSync(path.join(dir, "headroomd.pid"));
    for (let i = 0; i < 50 && !clean(); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(clean()).toBe(true);
  });
});

describe("frame overflow handling", () => {
  test("oversized frame answers best-effort E_PROTOCOL then destroys the client", async () => {
    const dir = await freshDir();
    const started = await startHeadroomServer({ dataDir: dir, maxFrameBytes: 1024 });
    if (started.status !== "listening") throw new Error("expected listening");
    stops.push(started.stop);

    const client = await rawConnect(started.socketPath);
    const closedByServer = new Promise<void>((resolve) => client.socket.once("close", resolve));

    // One giant unterminated frame: past maxFrameBytes with no newline.
    client.sendRaw("x".repeat(2000));

    const overflow = await client.nextResponse();
    expect(overflow.ok).toBe(false);
    expect((overflow.error as Record<string, unknown>).code).toBe("E_PROTOCOL");
    expect(String((overflow.error as Record<string, unknown>).message)).toContain("1024");

    // The connection does not survive the overflow: server tore it down.
    await closedByServer;
  });
});
