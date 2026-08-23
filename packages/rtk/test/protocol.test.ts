/**
 * Wire-protocol behavior of the raw server process (no RtkClient):
 * framing failures, unknown ops, param validation, and the simulateCrash
 * test-mode gate. All exercised over real pipes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RtkClient } from "../src/index";
import { makeDataDir, parseFrame, spawnRawServer, type RawServer } from "./helpers";

const openServers: RawServer[] = [];
const clientCleanups: Array<() => Promise<void>> = [];

async function freshServer(extraEnv?: Record<string, string>): Promise<RawServer> {
  const server = await spawnRawServer(extraEnv);
  openServers.push(server);
  return server;
}

function trackClient(cleanup: () => Promise<void>): void {
  clientCleanups.push(cleanup);
}

afterEach(async () => {
  while (clientCleanups.length > 0) {
    await clientCleanups.pop()?.();
  }
  while (openServers.length > 0) {
    const server = openServers.pop();
    server?.kill("SIGTERM");
    await Promise.race([server?.exited(), new Promise((r) => setTimeout(r, 500))]);
    server?.kill("SIGKILL");
  }
});

describe("raw server protocol", () => {
  test("hello frame is the first stdout line", async () => {
    const server = await freshServer();
    const hello = parseFrame<{ proto: number; pid: number }>(await server.stdout.readLine());
    expect(hello.proto).toBe(1);
    expect(hello.pid).toBe(server.proc.pid);
  });

  test("a half JSON line answers E_PROTOCOL without killing the loop", async () => {
    const server = await freshServer();
    await server.stdout.readLine(); // hello

    server.proc.stdin.write('{"v":1,"id":"half"');
    server.proc.stdin.write("\n");

    const response = parseFrame<{ id: string; ok: boolean; error: { code: string } }>(
      await server.stdout.readLine(),
    );
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("E_PROTOCOL");

    // The loop survives and serves well-formed frames afterwards.
    server.writeLine(JSON.stringify({ v: 1, id: "p1", op: "ping", params: {} }));
    const pong = parseFrame<{ id: string; ok: boolean; result?: { pong: boolean } }>(
      await server.stdout.readLine(),
    );
    expect(pong.ok).toBe(true);
    expect(pong.result?.pong).toBe(true);
    expect(server.proc.exitCode).toBeNull(); // still running
  });

  test("unknown op -> E_UNKNOWN_OP; malformed envelope -> E_PROTOCOL", async () => {
    const server = await freshServer();
    await server.stdout.readLine(); // hello

    server.writeLine(JSON.stringify({ v: 1, id: "u1", op: "explode", params: {} }));
    const unknownOp = parseFrame<{ id: string; error: { code: string } }>(
      await server.stdout.readLine(),
    );
    expect(unknownOp.id).toBe("u1");
    expect(unknownOp.error.code).toBe("E_UNKNOWN_OP");

    server.writeLine(JSON.stringify({ v: 2, id: "u2", op: "ping", params: {} }));
    const badVersion = parseFrame<{ id: string; error: { code: string } }>(
      await server.stdout.readLine(),
    );
    expect(badVersion.error.code).toBe("E_PROTOCOL");
  });

  test("compress with invalid params -> E_INVALID_PARAMS", async () => {
    const server = await freshServer();
    await server.stdout.readLine(); // hello

    server.writeLine(JSON.stringify({ v: 1, id: "b1", op: "compress", params: { tool: 42 } }));
    const response = parseFrame<{
      id: string;
      error: { code: string; detail?: string[] };
    }>(await server.stdout.readLine());
    expect(response.id).toBe("b1");
    expect(response.error.code).toBe("E_INVALID_PARAMS");
    expect(Array.isArray(response.error.detail)).toBe(true);
  });

  test("simulateCrash outside BLUECODE_TEST=1 refuses with E_PROTOCOL and keeps serving", async () => {
    const server = await freshServer();
    await server.stdout.readLine(); // hello

    server.writeLine(JSON.stringify({ v: 1, id: "s1", op: "simulateCrash", params: {} }));
    const refusal = parseFrame<{ id: string; error: { code: string } }>(
      await server.stdout.readLine(),
    );
    expect(refusal.error.code).toBe("E_PROTOCOL");

    server.writeLine(JSON.stringify({ v: 1, id: "s2", op: "ping", params: {} }));
    const pong = parseFrame<{ ok: boolean }>(await server.stdout.readLine());
    expect(pong.ok).toBe(true);
  });

  test("simulateCrash under BLUECODE_TEST=1 exits the process with code 137", async () => {
    const server = await freshServer({ BLUECODE_TEST: "1" });
    await server.stdout.readLine(); // hello

    server.writeLine(JSON.stringify({ v: 1, id: "k1", op: "simulateCrash", params: {} }));
    const code = await Promise.race([
      server.exited(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    expect(code).toBe(137);
  });

  test("client fetch degrades as unavailable while the server is down", async () => {
    // Degradation-matrix symmetry for fetch, driven through the client.
    const client = await RtkClient.create({ dataDir: await makeDataDir("fetchdown") });
    trackClient(() => client.shutdown());

    const healthy = await client.fetch(`sha256:${"b".repeat(64)}`);
    expect(healthy.kind).toBe("missing");

    process.kill(client.serverPid as number, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const degraded = await client.fetch(`sha256:${"c".repeat(64)}`);
    expect(degraded.kind).toBe("unavailable");
  });
});
