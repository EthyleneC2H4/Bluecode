/**
 * Factory spawn-recipe wiring: headroom.socketPath and headroom.idleExitMs
 * must reach the daemon through spawn.args — socketPath doubly so, because a
 * spawned daemon that never sees --socketPath binds the default path while
 * connect() polls the user's explicit one, failing every reconnect attempt
 * (audit round 2: both options were parsed-but-unwired).
 */
import { describe, expect, test, afterEach } from "bun:test";
import bluecodePlugin from "../src/index";
import { parseOptions } from "../src/config";
import { resetHeadroomState, setSharedHeadroomClient } from "../src/headroom";
import { resetRtkState } from "../src/rtk-hook";
import * as headroomModule from "@bluecode/headroomd";

const originalHeadroomConnect = headroomModule.HeadroomClient.connect;

function createMockInput() {
  return {
    client: {
      session: { messages: async () => [], get: async () => null },
    },
    project: { id: "proj-1" },
    directory: "/test",
    worktree: "/test",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: { run: async () => ({ text: "", exitCode: 0 }) },
  };
}

afterEach(async () => {
  (headroomModule.HeadroomClient as any).connect = originalHeadroomConnect;
  resetHeadroomState();
  resetRtkState();
});

describe("plugin factory: daemon spawn args", () => {
  test("configured socketPath + idleExitMs ride spawn.args; socketPath also stays on connect", async () => {
    let captured: any = null;
    (headroomModule.HeadroomClient as any).connect = async (opts: any) => {
      captured = opts;
      return {
        compress: async () => ({ compacted: false }),
        retrieve: async () => ({ found: false }),
        health: async () => ({ ok: true, pid: 1, uptimeMs: 0, sessions: 0 }),
        close: async () => {},
      };
    };

    const hooks = await bluecodePlugin(
      createMockInput() as unknown as any,
      parseOptions({ headroom: { socketPath: "/tmp/custom.sock", idleExitMs: 45000 } }),
    );
    await hooks.dispose?.();

    expect(captured).not.toBeNull();
    expect(captured.spawn.args).toEqual(["--socketPath", "/tmp/custom.sock", "--idleExitMs", "45000"]);
    // Explicit path must ALSO drive which socket connect() polls first.
    expect(captured.socketPath).toBe("/tmp/custom.sock");
  });

  test("default config forwards no args", async () => {
    let captured: any = null;
    (headroomModule.HeadroomClient as any).connect = async (opts: any) => {
      captured = opts;
      return {
        compress: async () => ({ compacted: false }),
        retrieve: async () => ({ found: false }),
        health: async () => ({ ok: true, pid: 1, uptimeMs: 0, sessions: 0 }),
        close: async () => {},
      };
    };

    const hooks = await bluecodePlugin(createMockInput() as any, parseOptions({}));
    await hooks.dispose?.();

    expect(captured?.spawn.args).toBeUndefined();
  });
});
