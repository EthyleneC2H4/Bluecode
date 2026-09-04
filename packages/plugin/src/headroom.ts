/**
 * Headroom integration: waterlevel monitoring, pending plan management,
 * messages.transform application, and compacting hook injection.
 */
import { HeadroomClient } from "@bluecode/headroomd";
import type { ChatMessage, HeadroomCompressParams } from "@bluecode/contracts";
import { COMPACTION_MARKER } from "@bluecode/headroomd";
import { estimateTokens } from "@bluecode/shared";
import { applyPlanInPlace, type CompactionPlan } from "./apply-plan";
import type { PluginOptions } from "./config";
import { resolveHeadroomEntry } from "./sidecar";

interface PendingPlan {
  plan: CompactionPlan;
  sessionId: string;
}

let headroomClient: HeadroomClient | null = null;
let headroomDegraded = false;

/**
 * Set the shared HeadroomClient instance (called by plugin factory).
 * This is the SINGLE client instance used by both headroom.ts and retrieve-tool.ts.
 */
export function setSharedHeadroomClient(client: HeadroomClient | null): void {
  headroomClient = client;
  if (client === null) headroomDegraded = false;
}

/**
 * Get the shared HeadroomClient instance.
 * Returns null if not initialized or degraded.
 */
export function getSharedHeadroomClient(): HeadroomClient | null {
  return headroomClient;
}

/**
 * Check if headroom is degraded (connection failed).
 */
export function isHeadroomDegraded(): boolean {
  return headroomDegraded;
}

/**
 * Mark headroom as degraded.
 */
export function setHeadroomDegraded(degraded: boolean): void {
  headroomDegraded = degraded;
}

// In-flight compress guard per session - stores the promise of the in-flight operation
const inFlightCompress = new Map<string, Promise<void>>();

// Pending plans waiting for messages.transform to consume
const pendingPlans = new Map<string, PendingPlan>();

/** Fallback context window when the SDK cannot report the model's real limit. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;

// Session ID -> model context window cache
const contextWindowCache = new Map<string, number>();

// Cache for model info fetched via SDK
interface ModelInfo {
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Get the shared HeadroomClient singleton.
 * Returns the client initialized by the plugin factory, or null if not initialized/degraded.
 * Does NOT create a new client - initialization happens once in the plugin factory.
 */
async function getHeadroomClient(
  _options: PluginOptions,
  _sdkClient: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient> | null,
): Promise<HeadroomClient | null> {
  if (headroomClient !== null) return headroomClient;
  if (headroomDegraded) return null;
  return null; // Not initialized yet - plugin factory will initialize it
}

/**
 * Extract token count from the most recent assistant message.
 * Returns the total context tokens or null if not available.
 *
 * SDK tokens carry components ({input,output,reasoning,cache{read,write}}),
 * not a total — sum them when total is absent (M7 smoke).
 */
function getLatestAssistantTokens(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.info.role === "assistant") {
      const tokens = (msg.info as { tokens?: Record<string, unknown> }).tokens;
      if (typeof tokens !== "object" || tokens === null) continue;
      const total = tokens.total;
      // total:0 is a zero-reporting provider, not a real reading — treating
      // it as present would bypass the estimator fallback below that exists
      // precisely for such providers (M7 smoke: free-tier gateway reports
      // zeros). Only a positive total counts as reported usage.
      if (typeof total === "number" && total > 0) return total;

      const cache = (tokens.cache ?? {}) as { read?: unknown; write?: unknown };
      const num = (v: unknown): number => (typeof v === "number" ? v : 0);
      const sum =
        num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(cache.read) + num(cache.write);
      if (num(tokens.input) > 0 || num(tokens.output) > 0 || sum > 0) return sum;
    }
  }
  return null;
}

/**
 * Convert an SDK list item ({ info, parts }) to the ChatMessage projection,
 * or null when the message has no projectable identity.
 *
 * Only contract-known content is projected: text and tool parts. Real
 * sessions also carry reasoning / step-start / step-finish parts which have
 * no wire representation — mapping them into pseudo tool parts produced
 * tool:undefined and E_INVALID_PARAMS from the daemon (M7 smoke).
 */
function sdkMessageToChatMessage(m: any): ChatMessage | null {
  const info = m.info ?? {};
  const id = typeof info.id === "string" ? info.id : undefined;
  const role = info.role === "user" || info.role === "assistant" ? info.role : undefined;
  if (id === undefined || role === undefined) return null;

  const parts = (m.parts ?? []).flatMap((p: any): Array<ChatMessage["parts"][number]> => {
    if (p?.type === "text" && typeof p.text === "string") {
      return [{ type: "text", text: p.text }];
    }
    if (p?.type === "tool" && typeof p.tool === "string") {
      const status = typeof p.state?.status === "string" ? p.state.status : "completed";
      return [
        {
          type: "tool",
          tool: p.tool,
          state: {
            status,
            // exactOptionalPropertyTypes: absent output stays absent.
            ...(typeof p.state?.output === "string" ? { output: p.state.output } : {}),
          },
        },
      ];
    }
    return []; // reasoning / step markers are not projectable content
  });

  return {
    info: {
      id,
      role,
      // Client-side only (getLatestAssistantTokens); stripped by the daemon's
      // schema, which knows nothing about it.
      ...(info.tokens ? { tokens: info.tokens } : {}),
    },
    parts,
  };
}

/** OpenCode v1.18.21 returns the complete oldest-to-newest session when limit is omitted. */
export async function fetchCompleteSessionMessages(
  sdkClient: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>,
  sessionId: string,
): Promise<any[]> {
  const result = await (sdkClient as any).session.messages({
    path: { id: sessionId },
  })
  return Array.isArray(result.data) ? result.data : []
}

/**
 * Fetch model context window via SDK.
 *
 * The serving model comes from the latest assistant message (Session carries
 * no model field in SDK 1.18), resolved against /config/providers. Returns
 * null on any mismatch — callers fall back to DEFAULT_CONTEXT_WINDOW_TOKENS.
 */
async function fetchModelContextWindow(
  sdkClient: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>,
  providerId?: string,
  modelId?: string,
): Promise<number | null> {
  if (providerId === undefined || modelId === undefined) return null;
  try {
    // hey-api generated client: request params are { path, query }, not flat
    // keys — a flat { id } silently misses and the request 404s (M7 smoke).
    const result = await (sdkClient as any).config.providers();
    const providers = result.data?.providers;
    if (!Array.isArray(providers)) return null;

    const provider = providers.find((p: any) => p.id === providerId);
    const model = provider?.models?.[modelId];
    const context = model?.limit?.context;
    // A misconfigured provider limit can report 0; callers treat the return
    // as a valid window, so 0 would zero out `usable` and compress every
    // idle cycle. Non-positive = unresolved: fall back to
    // DEFAULT_CONTEXT_WINDOW_TOKENS and keep it out of the cache.
    if (typeof context !== "number" || context <= 0) return null;
    return context;
  } catch {
    return null;
  }
}

/**
 * Check if compaction is already in progress (or recently done by us) for a
 * session. Detection is strictly structural: an upstream compaction tool part,
 * or our own COMPACTION_MARKER prefix on the latest user message. Never match
 * free text — a user message merely mentioning "compaction" must not suppress
 * waterlevel compression.
 */
function isCompactionInProgress(messages: ChatMessage[]): boolean {
  // Check if the most recent user message has a compaction part
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.info.role === "user") {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "compaction") return true;
        // Our own applied replacement: role=user, text starts with the marker.
        if (part.type === "text" && part.text.startsWith(COMPACTION_MARKER)) return true;
      }
      // If we hit a user message without compaction, we're not in compaction
      break;
    }
  }
  return false;
}

/**
 * Map an opencode plugin event envelope to a handleSessionIdle input, or null
 * when the event is not an idle signal for an identified session.
 *
 * Upstream dispatch shape is { event: { id, type, properties } }: payload
 * fields live under `properties`, not on the envelope. Reading sessionID off
 * the top level left it undefined and the idle path never fired in a real
 * host (M7 real-session smoke).
 */
export function eventToIdleInput(event: {
  type: string;
  properties?: Record<string, unknown>;
}): { sessionID: string; status?: { type: "idle" | "busy" | "retry" } } | null {
  const props = (event.properties ?? {}) as {
    sessionID?: string;
    status?: { type: "idle" | "busy" | "retry" };
  };
  if (props.sessionID === undefined) return null;
  if (event.type === "session.idle") return { sessionID: props.sessionID };
  if (event.type === "session.status" && props.status?.type === "idle") {
    return { sessionID: props.sessionID, status: props.status };
  }
  return null;
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

  // Breadcrumbs for the five silent gates below. Off by default; set
  // BLUECODE_DEBUG=1 to see why an idle did or did not trigger compression
  // (M7 smoke: a silent gate made live diagnosis guesswork).
  const debug = (msg: string): void => {
    if (process.env.BLUECODE_DEBUG) console.error(`[bluecode-plugin] idle: ${msg}`);
  };

  // Only act on idle status
  // session.idle event has no status field; session.status(idle) has status.type === "idle"
  const hasStatusIdle = event.status?.type === "idle";
  const isSessionIdleEvent = "sessionID" in event && !("status" in event);
  const isIdle = hasStatusIdle || isSessionIdleEvent;
  debug(`received sessionID=${event.sessionID} statusIdle=${hasStatusIdle} shapeIdle=${isSessionIdleEvent}`);
  if (!isIdle) return;

  const sessionId = event.sessionID;

  // Check if there's already an in-flight compress for this session
  const existing = inFlightCompress.get(sessionId);
  if (existing !== undefined) {
    // Another compress is in flight for this session, skip this cycle
    debug("skipped: compress already in flight");
    return;
  }

  // Create the in-flight promise and store it immediately
  const compressPromise = (async () => {
    const client = await getHeadroomClient(options, sdkClient);
    if (client === null) {
      debug("skipped: no headroom client");
      return;
    }

    // Check if upstream compaction is already in progress
    try {
      const messages = await fetchCompleteSessionMessages(sdkClient, sessionId);
      if (!messages || messages.length === 0) {
        debug("skipped: no session messages via SDK");
        return;
      }

      // The serving model rides on the latest assistant message (Session has
      // no model field in SDK 1.18).
      const latestAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant" && m.info?.modelID);

      // Convert SDK messages to the ChatMessage projection, preserving tokens
      const chatMessages = messages
        .map(sdkMessageToChatMessage)
        .filter((m: ChatMessage | null): m is ChatMessage => m !== null);

      if (isCompactionInProgress(chatMessages)) {
        debug("skipped: compaction already in progress");
        return; // Skip if compaction already running
      }

      // Get token count from latest assistant message
      const reported = getLatestAssistantTokens(chatMessages);
      // Providers that never report usage (all-zero components) still need
      // waterline protection: fall back to the shared O(1) estimator over the
      // projected conversation (M7 smoke: free-tier gateway reports zeros).
      const tokens =
        reported ??
        chatMessages.reduce((sum: number, m: ChatMessage) => {
          const text = m.parts
            .map((p: ChatMessage["parts"][number]) =>
              p.type === "text" ? p.text : (p.state.output ?? ""),
            )
            .join("\n");
          return sum + estimateTokens(text);
        }, 0);
      if (tokens === 0) {
        debug("skipped: no token usage and nothing estimable");
        return;
      }
      if (reported === null) {
        debug(`usage unreported; estimated tokens=${tokens}`);
      }

      // Get context window
      let contextWindow = contextWindowCache.get(sessionId);
      if (contextWindow === undefined) {
        const modelId = latestAssistant?.info?.modelID as string | undefined;
        const providerId = latestAssistant?.info?.providerID as string | undefined;
        debug(`resolving window via providers provider=${providerId} model=${modelId}`);
        contextWindow = await fetchModelContextWindow(sdkClient, providerId, modelId) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
        if (contextWindow > 0) contextWindowCache.set(sessionId, contextWindow);
      }

      const usable = contextWindow * options.headroom.triggerRatio;
      if (tokens < usable) {
        debug(`skipped: below waterline tokens=${tokens} usable=${usable}`);
        return; // Below waterline
      }

      const compressParams: HeadroomCompressParams = {
        sessionId,
        projectId: "default", // Project ID from opencode config
        messages: chatMessages,
        contextWindowTokens: contextWindow,
        triggerRatio: options.headroom.triggerRatio,
        retainRecentTurns: options.headroom.retainRecentTurns,
      };

      debug(`compressing tokens=${tokens} window=${contextWindow}`);
      const result = await client.compress(compressParams);
      debug(`compress done compacted=${result.compacted} refs=${result.refs.length}`);

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

  // Apply plan in place (idempotent). Delete the plan ONLY when it was
  // actually applied: the transform hook receives no sessionID (upstream
  // passes {} at both call sites), so the factory iterates every pending
  // session — a foreign session's message array matches none of this
  // plan's replacedMessageIds (opencode message ids are globally unique),
  // applyPlanInPlace returns no-match, and the plan must survive for its own
  // session's next transform. Deleting unconditionally would let one
  // session consume another's compression result.
  const status = applyPlanInPlace(output.messages, pending.plan);
  if (status === "applied") {
    pendingPlans.delete(sessionId);
  }
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
    `Use the \`headroom_retrieve\` tool to fetch original turns. ` +
    `If the compaction notice contains a historyHash, pass it as the \`historyHash\` argument and follow the pagination offsets.`,
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
