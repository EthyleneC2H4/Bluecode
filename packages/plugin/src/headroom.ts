/**
 * Headroom integration: waterlevel monitoring, pending plan management,
 * messages.transform application, and compacting hook injection.
 */
import { HeadroomClient } from "@bluecode/headroomd";
import type { ChatMessage, HeadroomCompressParams } from "@bluecode/contracts";
import { COMPACTION_MARKER } from "@bluecode/headroomd";
import { applyPlanInPlace, type CompactionPlan } from "./apply-plan";
import type { PluginOptions } from "./config";

interface PendingPlan {
  plan: CompactionPlan;
  sessionId: string;
}

let headroomClient: HeadroomClient | null = null;
let headroomDegraded = false;

// In-flight compress guard per session - stores the promise of the in-flight operation
const inFlightCompress = new Map<string, Promise<void>>();

// Pending plans waiting for messages.transform to consume
const pendingPlans = new Map<string, PendingPlan>();

// Session ID -> model context window cache
const contextWindowCache = new Map<string, number>();

// Cache for model info fetched via SDK
interface ModelInfo {
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Get or create the HeadroomClient singleton.
 * On connection failure, logs and returns null (headroom disabled for this session).
 */
async function getHeadroomClient(
  options: PluginOptions,
  sdkClient: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient> | null,
): Promise<HeadroomClient | null> {
  if (headroomClient !== null) return headroomClient;
  if (headroomDegraded) return null;

  try {
    const dataDir = options.dataDir;
    const socketPath = options.headroom.socketPath;
    const spawnEntry = options.headroom.entry;
    const spawnCwd = process.cwd();

    // Prepare spawn options if entry is provided
    const spawnOptions = spawnEntry !== undefined ? { entry: spawnEntry, cwd: spawnCwd } : undefined;

    // If spawning, ensure BLUECODE_DATA_DIR is set for the child
    if (spawnOptions !== undefined) {
      process.env.BLUECODE_DATA_DIR = dataDir;
    }

    headroomClient = await HeadroomClient.connect({
      dataDir,
      // exactOptionalPropertyTypes: absent options stay absent, not undefined.
      ...(socketPath !== undefined ? { socketPath } : {}),
      ...(spawnOptions !== undefined ? { spawn: spawnOptions } : {}),
      timeoutMs: 5000,
    });
    return headroomClient;
  } catch (err) {
    headroomDegraded = true;
    console.error(`[bluecode-plugin] headroom client connection failed, degrading: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Extract token count from the most recent assistant message.
 * Returns the total tokens or null if not available.
 */
function getLatestAssistantTokens(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.info.role === "assistant") {
      // Tokens may be on the message info (from SDK conversion) or directly on the message
      const tokens = (msg.info as { tokens?: { total?: number } }).tokens?.total;
      if (typeof tokens === "number") return tokens;
    }
  }
  return null;
}

/**
 * Convert SDK message format to ChatMessage format, preserving tokens.
 */
function sdkMessageToChatMessage(m: any): ChatMessage {
  return {
    info: {
      id: m.id,
      role: m.role,
      // Preserve tokens from SDK message
      ...(m.tokens ? { tokens: m.tokens } : {}),
    },
    parts: m.parts.map((p: any) => {
      if (p.type === "text") return { type: "text" as const, text: p.text };
      return { type: "tool" as const, tool: p.tool, state: { status: p.state?.status ?? "completed", output: p.state?.output ?? "" } };
    }),
  };
}

/**
 * Fetch model context window via SDK.
 */
async function fetchModelContextWindow(
  sdkClient: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>,
  sessionId: string,
): Promise<number | null> {
  try {
    // Get session to find the model, then get model info
    // Use type assertions to work with SDK result types
    const sessionResult = await (sdkClient as any).session.get({ id: sessionId });
    const session = sessionResult.data;
    if (!session || !session.model) return null;

    const modelResult = await (sdkClient as any).model.get({
      providerID: session.model.providerID,
      modelID: session.model.modelID,
    });
    const model = modelResult.data;
    if (!model) return null;

    return model.limit?.context ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if compaction is already in progress for a session.
 * We detect this by checking for the compaction.started event or by
 * seeing if there's already a compaction part in recent messages.
 */
function isCompactionInProgress(messages: ChatMessage[]): boolean {
  // Check if the most recent user message has a compaction part
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.info.role === "user") {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "compaction") return true;
        // Check for compaction part type in metadata
        if (part.type === "text" && part.text.includes("compaction")) return true;
      }
      // If we hit a user message without compaction, we're not in compaction
      break;
    }
  }
  return false;
}

/**
 * Event hook handler for session.idle / session.status (idle).
 * Triggers headroom compress when token waterlevel is reached.
 */
export async function handleSessionIdle(
  event: { sessionID: string; status?: { type: "idle" | "busy" | "retry" } },
  sdkClient: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>,
  options: PluginOptions,
): Promise<void> {
  if (!options.enabled) return;

  // Only act on idle status
  // session.idle event has no status field; session.status(idle) has status.type === "idle"
  const hasStatusIdle = event.status?.type === "idle";
  const isSessionIdleEvent = "sessionID" in event && !("status" in event);
  const isIdle = hasStatusIdle || isSessionIdleEvent;
  if (!isIdle) return;

  const sessionId = event.sessionID;

  // Check if there's already an in-flight compress for this session
  const existing = inFlightCompress.get(sessionId);
  if (existing !== undefined) {
    // Another compress is in flight for this session, skip this cycle
    return;
  }

  // Create the in-flight promise and store it immediately
  const compressPromise = (async () => {
    const client = await getHeadroomClient(options, sdkClient);
    if (client === null) return;

    // Check if upstream compaction is already in progress
    try {
      const messagesResult = await (sdkClient as any).session.messages({ sessionID: sessionId, limit: 100 });
      const messages = messagesResult.data;
      if (!messages || messages.length === 0) return;

      // Convert SDK messages to ChatMessage format, preserving tokens
      const chatMessages = messages.map(sdkMessageToChatMessage);

      if (isCompactionInProgress(chatMessages)) {
        return; // Skip if compaction already running
      }

      // Get token count from latest assistant message
      const tokens = getLatestAssistantTokens(chatMessages);
      if (tokens === null) return;

      // Get context window
      let contextWindow = contextWindowCache.get(sessionId);
      if (contextWindow === undefined) {
        contextWindow = await fetchModelContextWindow(sdkClient, sessionId) ?? 200000; // Fallback
        if (contextWindow > 0) contextWindowCache.set(sessionId, contextWindow);
      }

      const usable = contextWindow * options.headroom.triggerRatio;
      if (tokens < usable) return; // Below waterlevel

      const compressParams: HeadroomCompressParams = {
        sessionId,
        projectId: "default", // Project ID from opencode config
        messages: chatMessages,
        contextWindowTokens: contextWindow,
        triggerRatio: options.headroom.triggerRatio,
        retainRecentTurns: options.headroom.retainRecentTurns,
      };

      const result = await client.compress(compressParams);

      if (result.compacted) {
        // Store pending plan for messages.transform to consume
        pendingPlans.set(sessionId, {
          plan: {
            refs: result.refs,
            summary: result.summary,
            replacedMessageIds: result.replacedMessageIds,
            historyHash: result.historyHash,
          },
          sessionId,
        });
      }
    } catch (err) {
      console.error(`[bluecode-plugin] headroom idle handler error: ${(err as Error).message}`);
    }
  })();

  inFlightCompress.set(sessionId, compressPromise);
  try {
    await compressPromise;
  } finally {
    inFlightCompress.delete(sessionId);
  }
}

/**
 * messages.transform hook handler.
 * Consumes pending plan and applies it in place.
 */
export async function handleMessagesTransform(
  output: { messages: ChatMessage[] },
  sessionId: string,
): Promise<void> {
  const pending = pendingPlans.get(sessionId);
  if (!pending) return; // No plan to apply

  // Apply plan in place (idempotent)
  applyPlanInPlace(output.messages, pending.plan);

  // Clear the plan after applying
  pendingPlans.delete(sessionId);
}

/**
 * compacting hook handler.
 * Injects context when fallback is "upstream".
 */
export async function handleCompacting(
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
  options: PluginOptions,
): Promise<void> {
  if (!options.enabled) return;
  if (options.headroom.fallback !== "upstream") return; // passthrough = no-op

  // Find the historyHash from recent messages (compaction replacement)
  // For now, we don't have direct access to messages here, but we can
  // inject a generic template. The brief specifies a template with historyHash
  // and headroom_retrieve usage hint.
  output.context.push(
    `[bluecode headroom] Conversation history was compacted. ` +
    `Use the \`headroom_retrieve\` tool to fetch original turns by hash. ` +
    `If you have a historyHash from the compaction notice, pass it as \`hash\` to retrieve the full text.`,
  );
}

/**
 * Shutdown the headroom client (best effort).
 */
export async function shutdownHeadroom(): Promise<void> {
  if (headroomClient !== null) {
    try {
      await headroomClient.close();
    } catch {
      // best effort
    }
    headroomClient = null;
    headroomDegraded = false;
  }
  inFlightCompress.clear();
  pendingPlans.clear();
  contextWindowCache.clear();
}

/**
 * Reset headroom state (test-only).
 */
export function resetHeadroomState(): void {
  headroomClient = null;
  headroomDegraded = false;
  inFlightCompress.clear();
  pendingPlans.clear();
  contextWindowCache.clear();
}

/**
 * Get pending plan for a session, or all plans if no sessionId provided (test-only).
 */
export function getPendingPlan(sessionId?: string): Map<string, PendingPlan> | PendingPlan | undefined {
  if (sessionId !== undefined) {
    return pendingPlans.get(sessionId);
  }
  return pendingPlans;
}

/**
 * Set pending plan for a session (test-only).
 */
export function setPendingPlan(sessionId: string, plan: CompactionPlan): void {
  pendingPlans.set(sessionId, { plan, sessionId });
}

/**
 * Clear pending plan for a session (test-only).
 */
export function clearPendingPlan(sessionId: string): void {
  pendingPlans.delete(sessionId);
}