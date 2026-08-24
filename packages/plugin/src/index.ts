/**
 * @bluecode/opencode-plugin-bluecode — Main plugin factory.
 *
 * Registers all 6 hook surfaces:
 * 1. tool.execute.after — rtk compression
 * 2. experimental.chat.messages.transform — headroom plan application
 * 3. experimental.session.compacting — headroom fallback context injection
 * 4. event (session.idle) — headroom waterlevel monitoring
 * 5. tool (headroom_retrieve) — history retrieval tool
 * 6. dispose — cleanup on plugin unload
 */
// NOT exported: opencode's legacy plugin loader iterates every named export
// of the module and throws "Plugin export is not a function" on any
// non-function value (found in M7 real-session smoke). The plugin factory
// rides on the default export alone.
const VERSION = "0.0.1" as const;

import type { PluginInput, PluginOptions, Hooks } from "@opencode-ai/plugin";
import { parseOptions, type PluginOptions as InternalOptions } from "./config";
import { handleToolExecuteAfter, shutdownRtk, resetRtkState } from "./rtk-hook";
import {
  handleSessionIdle,
  eventToIdleInput,
  handleMessagesTransform,
  handleCompacting,
  shutdownHeadroom,
  resetHeadroomState,
  setPendingPlan,
  getPendingPlan,
  clearPendingPlan,
  setSharedHeadroomClient,
} from "./headroom";
import { headroomRetrieveTool } from "./retrieve-tool";
import { resolveHeadroomEntry } from "./sidecar";
import { HeadroomClient } from "@bluecode/headroomd";

// Type for the SDK client (minimal projection to avoid importing opencode-dev)
type SDKClient = ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>;

/**
 * Plugin factory function.
 * Called by opencode with (input, options) where options comes from the
 * second element of the plugin array in opencode.json.
 */
export default async function bluecodePlugin(
  input: PluginInput,
  rawOptions?: PluginOptions,
): Promise<Hooks> {
  // Parse and validate options with defaults
  const options = parseOptions(rawOptions ?? {});

  if (!options.enabled) {
    return {
      dispose: async () => {},
      tool: {},
    };
  }

  const { client: sdkClient } = input;

  // Initialize headroom client (connect or spawn)
  let headroomClientInstance: HeadroomClient | null = null;
  try {
    const dataDir = options.dataDir;
    const socketPath = options.headroom.socketPath;

    // Always supply a spawn recipe (see sidecar.ts / headroom.ts rationale):
    // without one, HeadroomClient.connect never spawns and a default-config
    // install cannot self-heal a dead daemon.
    const spawnOptions = { entry: resolveHeadroomEntry(options), cwd: process.cwd() };

    process.env.BLUECODE_DATA_DIR = dataDir;

    const connectOptions: {
      dataDir: string;
      socketPath?: string;
      spawn: { entry: string; cwd: string };
      timeoutMs: number;
    } = { dataDir, spawn: spawnOptions, timeoutMs: 5000 };
    if (socketPath !== undefined) connectOptions.socketPath = socketPath;

    headroomClientInstance = await HeadroomClient.connect(connectOptions);
    setSharedHeadroomClient(headroomClientInstance);
  } catch (err) {
    console.error(`[bluecode-plugin] headroom client initialization failed: ${(err as Error).message}`);
    // Continue without headroom - rtk may still work
  }

  // Event hook for session.idle (waterlevel monitoring)
  const eventHook = async (eventInput: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => {
    // Payload fields arrive under event.properties (upstream dispatch shape —
    // see eventToIdleInput); the envelope carries only id/type.
    const input = eventToIdleInput(eventInput.event);
    if (input !== null) {
      await handleSessionIdle(input, sdkClient, options);
    }
  };

  // messages.transform hook
  const messagesTransformHook = async (
    _input: {},
    output: { messages: Array<{ info: { id: string; role: string }; parts: Array<{ type: string; text?: string; tool?: string; state?: { status?: string; output?: string } }> }> },
  ) => {
    // The transform hook doesn't receive sessionID directly.
    // We iterate over all pending plans and apply them.
    const plans = getPendingPlan();
    if (plans instanceof Map) {
      for (const [sessionId] of plans) {
        await handleMessagesTransform(output as any, sessionId);
      }
    }
  };

  // compacting hook
  const compactingHook = async (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => {
    await handleCompacting(input, output, options);
  };

  // Dispose hook for cleanup
  const disposeHook = async () => {
    await shutdownRtk();
    await shutdownHeadroom();
    setSharedHeadroomClient(null);
  };

  // Wrap tool.execute.after to capture options via closure (opencode only passes input, output)
  const toolExecuteAfterHook = async (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => {
    await handleToolExecuteAfter(input, output, options);
  };

  return {
    dispose: disposeHook,
    event: eventHook,
    "experimental.chat.messages.transform": messagesTransformHook,
    "experimental.session.compacting": compactingHook,
    "tool.execute.after": toolExecuteAfterHook,
    tool: {
      headroom_retrieve: headroomRetrieveTool as any,
    },
  };
}

// NOTE: no named exports beyond the default factory. opencode's legacy
// plugin loader iterates every runtime export of this module and treats it
// as a plugin instance — non-function values (and plain helper functions,
// which would be invoked with a PluginInput signature) break load or crash
// at hook time. Tests import internals via their submodule deep paths.
