/**
 * tool.execute.after hook handler for rtk compression.
 *
 * - Only processes string outputs
 * - Calls RtkClient.compress with the tool output
 * - On compressed: mutates output.output in place, writes metadata.bluecode
 * - On passthrough with degraded: writes metadata.bluecode.degraded for observability
 * - NEVER throws: all errors are caught and logged to stderr
 */
import { RtkClient, type CompressInput, type CompressOutcome } from "@bluecode/rtk";
import type { PluginOptions } from "./config";
import { resolveRtkEntry } from "./sidecar";

let rtkClient: RtkClient | null = null;
let rtkDegraded = false;

/**
 * Get or create the RtkClient singleton.
 * On creation failure, logs and returns null (rtk disabled for this session).
 */
async function getRtkClient(options: PluginOptions): Promise<RtkClient | null> {
  if (rtkClient !== null) return rtkClient;
  if (rtkDegraded) return null;

  try {
    const createOptions: {
      budgetTokens: number;
      timeoutMs: number;
      minBytes: number;
      dataDir: string;
      entry?: string;
    } = {
      budgetTokens: options.rtk.budgetTokens,
      timeoutMs: options.rtk.timeoutMs,
      minBytes: options.rtk.minBytes,
      dataDir: options.dataDir,
    };
    // Explicit option > BLUECODE_SIDECAR_DIR > undefined (client self-resolves).
    const entry = resolveRtkEntry(options);
    if (entry !== undefined) {
      createOptions.entry = entry;
    }
    rtkClient = await RtkClient.create(createOptions);
    return rtkClient;
  } catch (err) {
    rtkDegraded = true;
    console.error(`[bluecode-plugin] rtk client creation failed, degrading to passthrough: ${(err as Error).message}`);
    return null;
  }
}

/**
 * tool.execute.after hook handler.
 *
 * @param input Hook input: { tool, sessionID, callID, args }
 * @param output Hook output (mutated in place): { title, output, metadata }
 * @param options Plugin options
 */
export async function handleToolExecuteAfter(
  input: { tool: string; sessionID: string; callID: string; args: unknown },
  output: { title: string; output: unknown; metadata: Record<string, unknown> | undefined },
  options: PluginOptions,
): Promise<void> {
  if (!options.enabled) return;

  // Only process string outputs
  if (typeof output.output !== "string") return;

  const client = await getRtkClient(options);
  if (client === null) return;

  const compressInput: CompressInput = {
    tool: input.tool,
    output: output.output,
    title: output.title,
    metadata: output.metadata ?? {},
    sessionId: input.sessionID,
    callId: input.callID,
  };

  try {
    const outcome: CompressOutcome = await client.compress(compressInput);

    if (outcome.kind === "compressed") {
      const { result } = outcome;
      // Mutate output in place
      output.output = result.output;
      // Ensure metadata object exists
      if (output.metadata === undefined) output.metadata = {};
      output.metadata.bluecode = {
        rawHash: result.rawHash,
        strategy: result.strategy,
        compressed: true,
        outTokensEst: result.outTokensEst,
        rawTokensEst: result.rawTokensEst,
      };
    } else if (outcome.kind === "passthrough" && outcome.degraded !== null) {
      // Observability: mark degraded passthrough
      if (output.metadata === undefined) output.metadata = {};
      output.metadata.bluecode = { degraded: outcome.degraded };
    }
    // passthrough with degraded === null (fast path) leaves output untouched, no metadata
  } catch (err) {
    // NEVER throw from a hook — it would corrupt the host tool call path
    console.error(`[bluecode-plugin] rtk hook error (swallowed): ${(err as Error).message}`);
  }
}

/**
 * Shutdown the rtk client (best effort).
 */
export async function shutdownRtk(): Promise<void> {
  if (rtkClient !== null) {
    try {
      await rtkClient.shutdown();
    } catch {
      // best effort
    }
    rtkClient = null;
    rtkDegraded = false;
  }
}

/**
 * Reset rtk state (test-only).
 */
export function resetRtkState(): void {
  rtkClient = null;
  rtkDegraded = false;
}