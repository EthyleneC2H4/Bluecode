/** Instance-scoped orchestration. Hooks apply ready work; sidecar work is coalesced. */
import { contentDigest } from "@bluecode/headroomd/pure"
import { createHash } from "node:crypto"
import type {
  HeadroomCompressParams,
  HeadroomCompressResult,
  HeadroomRetrieveParams,
  HeadroomRetrieveResult,
  Namespace,
  GetCandidateParams,
  GetCandidateResult,
} from "@bluecode/contracts"
import type { CompressInput, CompressOutcome, FetchInput, FetchOutcome } from "@bluecode/rtk/client"
import { estimateTokens, redactLocalPaths } from "@bluecode/shared"
import type { PluginOptions } from "./config"
import {
  applyHostView,
  projectMessages,
  projectMessage,
  sessionOf,
  upstreamEpoch,
  type HostMessage,
} from "./host-adapter"

export interface RtkPort {
  compress(input: CompressInput): Promise<CompressOutcome>
  fetch(input: FetchInput): Promise<FetchOutcome>
  shutdown(): Promise<void>
}
export interface HeadroomPort {
  getCandidate?(input: GetCandidateParams): Promise<GetCandidateResult>
  compress(input: HeadroomCompressParams): Promise<HeadroomCompressResult>
  retrieve(input: HeadroomRetrieveParams): Promise<HeadroomRetrieveResult>
  getView(namespace: Namespace): Promise<HeadroomCompressResult | null>
  setView(namespace: Namespace, plan: HeadroomCompressResult): Promise<void>
  clearView(namespace: Namespace): Promise<void>
  close(): Promise<void>
}
type Mode = "off" | "shadow" | "on"
interface Model {
  providerID?: string
  id?: string
  modelID?: string
  limit?: { context?: number; input?: number; output?: number }
}
interface SessionState {
  snapshot?: HostMessage[]
  view?: HeadroomCompressResult
  epoch?: string
  paused: boolean
  hydrated: boolean
  hydrating?: boolean
  busy: boolean
  model?: Model
  maxOutput?: number
  systemTokens: number
  attempted?: string
  generation: number
  enhancementJob?: string
}
/** Explicit metadata only; never includes host content, options, or provider secrets. */
export interface RuntimeTraceEvent {
  stage: string
  reason: string
  sessionId: string
  generation: number
  strategy: string
  details: Record<string, string | number | boolean | null>
}
export interface RuntimeInput {
  trace?: (event: RuntimeTraceEvent) => void | Promise<void>
  projectId: string
  directory: string
  options: PluginOptions
  rtk: RtkPort | null
  headroom: HeadroomPort | null
  sdk?: {
    session?: { messages: (input: any) => Promise<any> }
    config?: { providers: () => Promise<any> }
  }
}

export function createPluginRuntime(input: RuntimeInput) {
  const { options, projectId } = input
  let disposed = false
  const sessions = new Map<string, SessionState>()
  const jobs = new Set<Promise<void>>()
  const models = new Map<string, { model: Model; expires: number }>()
  const queue: Array<{ run: () => Promise<void>; bytes: number }> = []
  let active = 0,
    queuedBytes = 0
  const metrics = {
    plans: 0,
    applied: 0,
    invalidated: 0,
    overloaded: 0,
    errors: 0,
    rtkCalls: 0,
    retrievalBypasses: 0,
    shadowPlans: 0,
  }
  const mode = (component: "rtk" | "headroom"): Mode =>
    !options.enabled || options.mode === "off"
      ? "off"
      : options.mode === "shadow"
      ? "shadow"
      : options[component].mode ?? options.mode
  const namespace = (sessionId: string): Namespace => ({ projectId, sessionId })
  const track = (operation: Promise<void>) => {
    const handled = operation
      .catch((error: unknown) => {
        metrics.errors++
        console.warn(
          `[bluecode] ${redactLocalPaths(error instanceof Error ? error.message : String(error))}`
        )
      })
      .finally(() => jobs.delete(handled))
    jobs.add(handled)
  }
  const pump = () => {
    while (!disposed && active < 2 && queue.length > 0) {
      const item = queue.shift()!
      queuedBytes -= item.bytes
      active++
      track(
        item.run().finally(() => {
          active--
          pump()
        })
      )
    }
  }
  const enqueue = (run: () => Promise<void>, bytes = 0): boolean => {
    if (disposed || queue.length + active >= 32 || queuedBytes + bytes > 8 * 1024 ** 2) {
      metrics.overloaded++
      return false
    }
    queue.push({ run, bytes })
    queuedBytes += bytes
    pump()
    return true
  }
  const stateFor = (id: string): SessionState | null => {
    let state = sessions.get(id)
    if (state) return state
    if (sessions.size >= 64) {
      const idle = [...sessions].find(([, s]) => !s.busy)
      if (!idle) {
        metrics.overloaded++
        return null
      }
      sessions.delete(idle[0])
    }
    state = { paused: false, hydrated: false, busy: false, systemTokens: 0, generation: 0 }
    sessions.set(id, state)
    return state
  }
  const trace = (id: string, state: SessionState, stage: string, reason: string,
    details: RuntimeTraceEvent["details"] = {}) => {
    try {
      const pending = input.trace?.({ stage, reason, sessionId: id, generation: state.generation, strategy: options.headroom.strategy, details })
      if (pending) void Promise.resolve(pending).catch(() => {})
    } catch { /* Diagnostics must not affect host execution. */ }
  }
  const clearView = (id: string, state: SessionState) => {
    trace(id, state, "view", "clear")
    delete state.view
    delete state.attempted
    state.generation++
    metrics.invalidated++
    if (input.headroom && mode("headroom") === "on")
      enqueue(() => input.headroom!.clearView(namespace(id)))
  }
  const hydrate = (id: string, state: SessionState) => {
    if (state.hydrated || !input.headroom || mode("headroom") === "off") return
    state.hydrated = true
    state.hydrating = true
    const generation = state.generation
    const accepted = enqueue(async () => {
      try {
        const plan = await input.headroom!.getView(namespace(id))
        const strategyMismatch = plan && (plan.strategy ?? "legacy") !== options.headroom.strategy
        // Enhanced plans retain model identity but not the provider/config
        // provenance needed to prove restart compatibility. Rebuild from raw
        // history even when the model name still matches the current config.
        const enhanced = plan?.nodes?.some(node => node.policyVersion.startsWith("layered-summary-"))
        if (strategyMismatch || enhanced) {
          trace(id, state, "hydrate", strategyMismatch ? "strategy-mismatch" : "enhanced-provider-unverified")
          if (mode("headroom") === "on") await input.headroom!.clearView(namespace(id))
          return
        }
        if (
          !disposed &&
          !state.view &&
          generation === state.generation &&
          plan?.sourceDigests &&
          plan.epoch === (state.epoch ?? "")
        )
          state.view = plan
      } catch (error) {
        state.hydrated = false
        throw error
      } finally {
        state.hydrating = false
        if (!disposed && sessions.get(id) === state && state.hydrated) schedule(id, state)
      }
    })
    if (!accepted) { state.hydrated = false; state.hydrating = false }
  }
  const usableBudget = (state: SessionState): number | null => {
    const limit = state.model?.limit
    const context = limit?.context
    if (!limit || typeof context !== "number" || !Number.isFinite(context) || context <= 0)
      return null
    const output = state.maxOutput ?? limit.output ?? 0
    const usable =
      Math.min(limit.input && limit.input > 0 ? limit.input : context, context - output) -
      state.systemTokens -
      512
    return usable > 0 ? usable : null
  }
  async function resolveModel(state: SessionState) {
    if (state.model?.limit || !input.sdk?.config) return
    const providerID = state.model?.providerID,
      modelID = state.model?.id ?? state.model?.modelID
    if (!providerID || !modelID) return
    const key = JSON.stringify([providerID, modelID])
    const cached = models.get(key)
    if (cached && cached.expires > Date.now()) {
      state.model = cached.model
      return
    }
    const result = await input.sdk.config.providers()
    const found = result.data?.providers?.find((provider: any) => provider.id === providerID)
      ?.models?.[modelID]
    if (found?.limit?.context > 0) {
      const model = { providerID, id: modelID, limit: found.limit }
      models.set(key, { model, expires: Date.now() + 60_000 })
      if (models.size > 64) models.delete(models.keys().next().value!)
      if (
        state.model?.providerID === providerID &&
        (state.model.id ?? state.model.modelID) === modelID
      )
        state.model = model
    }
    // Missing limits are intentionally never cached as a fabricated model.
  }
  const pollEnhancement = (id: string, state: SessionState, base: HeadroomCompressResult, generation: number) => {
    const jobId = base.enhancementJobId
    if (!jobId || !input.headroom?.getCandidate || !options.headroom.summarizer.enabled || state.enhancementJob === jobId) return
    state.enhancementJob = jobId
    // This promise is tracked for shutdown, but never consumes the rule queue's two permits.
    track((async () => {
      try {
        const until = Date.now() + options.headroom.summarizer.timeoutMs + 1000
        while (Date.now() < until && !disposed && !state.paused && state.generation === generation &&
            sessions.get(id) === state && state.view?.historyHash === base.historyHash) {
          const raw = state.snapshot, projection = raw ? projectMessages(raw) : null
          if (!projection || applyHostView(structuredClone(raw!), base) !== "applied") return
          const result = await input.headroom!.getCandidate!({ namespace: namespace(id), jobId,
            epoch: state.epoch ?? "", sourceDigests: projection.map(contentDigest) })
          if (result.status === "ready" && result.candidate) {
            if (disposed || state.paused || state.generation !== generation || state.view?.historyHash !== base.historyHash ||
                !state.snapshot || applyHostView(structuredClone(state.snapshot), result.candidate) !== "applied") return
            await input.headroom!.setView(namespace(id), result.candidate)
            if (!disposed && !state.paused && state.generation === generation && state.view?.historyHash === base.historyHash) {
              state.view = result.candidate
              metrics.plans++
            }
            return
          }
          if (result.status !== "queued" && result.status !== "running") return
          await new Promise<void>(resolve => setTimeout(resolve, 100))
        }
      } finally { if (state.enhancementJob === jobId) delete state.enhancementJob }
    })())
  }
  const schedule = (id: string, state: SessionState) => {
    const blocked = mode("headroom") === "off" ? "disabled" : !input.headroom ? "no-port" : state.hydrating ? "hydrating" : state.paused ? "paused" : state.busy ? "busy" : !state.snapshot ? "no-snapshot" : null
    if (blocked) { trace(id, state, "schedule", blocked); return }
    const raw = state.snapshot!
    trace(id, state, "schedule", "queued", { messages: raw.length })
    state.busy = true
    const generation = state.generation
    const accepted = enqueue(
      async () => {
        try {
          await resolveModel(state)
          if (disposed || state.paused || state.generation !== generation) {
            trace(id, state, "schedule", disposed ? "disposed" : state.paused ? "paused" : "generation-changed", { plannedGeneration: generation }); return
          }
          const usable = usableBudget(state)
          const projection = projectMessages(raw)
          if (!usable || !projection) { trace(id, state, "schedule", !usable ? "no-budget" : "invalid-projection"); return }
          const effective = structuredClone(raw)
          if (state.view) applyHostView(effective, state.view)
          const projectedEffective = projectMessages(effective)
          if (!projectedEffective) { trace(id, state, "schedule", "invalid-effective-projection"); return }
          const tokens = projectedEffective.reduce(
            (sum, m) => sum + estimateTokens(JSON.stringify(m.parts)),
            0
          )
          if (tokens < usable * options.headroom.triggerRatio) { trace(id, state, "schedule", "below-trigger", { tokens, usable }); return }
          const fingerprint = createHash("sha256")
            .update(JSON.stringify([projection, state.epoch, usable, options.headroom]))
            .digest("hex")
          if (state.attempted === fingerprint) { trace(id, state, "schedule", "already-attempted"); return }
          state.attempted = fingerprint
          trace(id, state, "compress", "started", { tokens, usable, plannedGeneration: generation })
          const result = await input.headroom!.compress({
            projectId,
            sessionId: id,
            messages: projection,
            contextWindowTokens: usable,
            targetTokens: Math.floor(usable * options.headroom.targetRatio),
            triggerRatio: options.headroom.triggerRatio,
            retainRecentTurns: options.headroom.retainRecentTurns,
            strategy: options.headroom.strategy,
            memoryMaxTokens: options.headroom.memoryMaxTokens,
            memoryRatio: options.headroom.memoryRatio,
            enhance: options.headroom.summarizer.enabled && mode("headroom") === "on",
            ...(options.headroom.summarizer.enabled ? { summaryProvider: options.headroom.summarizer } : {}),
            epoch: state.epoch ?? "",
          })
          if (result.enhancementReason) console.warn(`[bluecode] ${result.enhancementReason}`)
          trace(id, state, "compress", "returned", { compacted: result.compacted, sourceCount: result.sourceSnapshot?.messageIds.length ?? 0, operations: result.operations?.length ?? 0, plannedGeneration: generation })
          const rejection = disposed ? "disposed" : state.paused ? "paused" : generation !== state.generation ? "generation-changed" : !result.compacted ? "not-compacted" : !result.sourceDigests ? "missing-digests" : null
          if (rejection) { trace(id, state, "publish", rejection, { plannedGeneration: generation }); return }
          // Validate against the freshest raw host snapshot before publishing a durable active view.
          const candidate = structuredClone(state.snapshot ?? raw)
          const status = applyHostView(candidate, result)
          if (status !== "applied") { trace(id, state, "publish", "invalid-view", { status, messages: candidate.length }); return }
          metrics.plans++
          if (mode("headroom") === "shadow") {
            metrics.shadowPlans++
            trace(id, state, "publish", "shadow")
            return
          }
          trace(id, state, "publish", "persisting")
          await input.headroom!.setView(namespace(id), result)
          if (!disposed && !state.paused && generation === state.generation) {
            state.view = result
            trace(id, state, "publish", "ready")
            pollEnhancement(id, state, result, generation)
          } else trace(id, state, "publish", "changed-during-persist", { plannedGeneration: generation })
        } catch (error) {
          delete state.attempted
          trace(id, state, "schedule", "error")
          throw error
        } finally {
          state.busy = false
        }
      },
      Buffer.byteLength(JSON.stringify(raw))
    )
    if (!accepted) { state.busy = false; trace(id, state, "schedule", "overloaded") }
  }

  const runtime = {
    strategy: () => options.headroom.strategy,
    rtk: () => input.rtk,
    headroom: () => input.headroom,
    namespace,
    stats: () => ({
      ...metrics,
      sessions: sessions.size,
      active,
      queued: queue.length,
      queuedBytes,
    }),
    observeModel(id: string, model: Model, maxOutput?: number) {
      const state = stateFor(id)
      if (!state || disposed) return
      const previous = state.model
      const oldKey = JSON.stringify(state.model)
      const newKey = JSON.stringify(model)
      state.model = model
      if (maxOutput !== undefined && Number.isFinite(maxOutput) && maxOutput >= 0)
        state.maxOutput = maxOutput
      else delete state.maxOutput
      if (oldKey !== newKey) {
        delete state.attempted
        state.generation++
      }
      trace(id, state, "model", oldKey === newKey ? "unchanged" : "changed", {
        identityChanged: previous?.id !== model.id || previous?.modelID !== model.modelID || previous?.providerID !== model.providerID,
        limitChanged: JSON.stringify(previous?.limit) !== JSON.stringify(model.limit),
        shapeChanged: JSON.stringify(Object.keys(previous ?? {}).sort()) !== JSON.stringify(Object.keys(model).sort()),
        context: model.limit?.context ?? null, output: model.limit?.output ?? null, maxOutput: state.maxOutput ?? null,
      })
    },
    observeSystem(id: string, model: Model, system: string[]) {
      const state = stateFor(id)
      if (!state) return
      if (
        !state.model?.limit ||
        state.model.id !== model.id ||
        state.model.providerID !== model.providerID
      )
        runtime.observeModel(id, model)
      state.systemTokens = estimateTokens(system.join("\n"))
      trace(id, state, "system", "observed", { systemTokens: state.systemTokens })
    },
    async transform(output: { messages: HostMessage[] }) {
      if (disposed || mode("headroom") === "off") return
      const id = sessionOf(output.messages)
      if (!id) return
      const state = stateFor(id)
      if (!state) return
      const epoch = upstreamEpoch(output.messages)
      if (state.epoch !== undefined && state.epoch !== epoch) clearView(id, state)
      state.epoch = epoch
      // Keep a private immutable snapshot; the host continues mutating its own array.
      state.snapshot = structuredClone(output.messages)
      if (!state.model) {
        const info = [...output.messages].reverse().find((m) => m.info.modelID || m.info.model)
          ?.info
        if (info?.modelID)
          state.model = { providerID: String(info.providerID), id: String(info.modelID) }
        else if (info?.model) state.model = info.model as Model
      }
      hydrate(id, state)
      if (state.paused) return
      if (state.view && mode("headroom") === "on") {
        const status = applyHostView(output.messages, state.view)
        trace(id, state, "transform", "view", { status })
        if (status === "applied") metrics.applied++
        else if (status !== "already-compacted") clearView(id, state)
      }
      schedule(id, state)
    },
    async toolAfter(
      event: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { output?: unknown; content?: any[]; title?: string; metadata?: any }
    ) {
      if (disposed || mode("rtk") === "off") return
      if (event.tool === "headroom_retrieve" || output.metadata?.bluecode?.retrieved === true) {
        metrics.retrievalBypasses++
        return
      }
      if (!input.rtk) return
      const toolArgs =
        typeof event.args === "object" && event.args !== null
          ? (Object.fromEntries(
              Object.entries(event.args).filter(
                ([, value]) =>
                  value === null || ["string", "number", "boolean"].includes(typeof value)
              )
            ) as CompressInput["toolArgs"])
          : undefined
      const run = async (text: string, suffix: string): Promise<string> => {
        metrics.rtkCalls++
        const result = await input.rtk!.compress({
          tool: event.tool,
          output: text,
          title: output.title ?? event.tool,
          metadata: output.metadata ?? {},
          sessionId: JSON.stringify([projectId, event.sessionID]),
          callId: `${event.callID}${suffix}`,
          ...(toolArgs ? { toolArgs } : {}),
        })
        if (mode("rtk") === "shadow") return text
        if (result.kind === "compressed") {
          output.metadata = {
            ...output.metadata,
            bluecode: { ...result.result, output: undefined },
          }
          return result.result.output
        }
        if (result.degraded)
          output.metadata = {
            ...output.metadata,
            bluecode: { degraded: result.degraded, status: result.status },
          }
        return text
      }
      try {
        if (typeof output.output === "string") output.output = await run(output.output, "")
        if (Array.isArray(output.content)) {
          const textParts = output.content
            .map((part, index) => ({ part, index }))
            .filter(({ part }) => part?.type === "text" && typeof part.text === "string")
          // Start together: each request's queue time consumes the same per-call deadline.
          const values = await Promise.all(
            textParts.map(({ part, index }) => run(part.text, `:${index}`))
          )
          textParts.forEach(({ part }, index) => {
            part.text = values[index]!
          })
        }
      } catch (error) {
        metrics.errors++
        console.warn(`[bluecode] tool compression: ${redactLocalPaths(String(error))}`)
      }
    },
    async idle(id: string) {
      if (disposed || mode("headroom") === "off") return
      const state = stateFor(id)
      if (!state) return
      // SDK session.messages includes history upstream has already hidden.
      // Wait for the next authoritative messages.transform snapshot instead.
      schedule(id, state)
    },
    async event(event: { type: string; properties?: Record<string, any> }) {
      const id =
        event.type === "session.deleted"
          ? event.properties?.info?.id ?? event.properties?.sessionID
          : event.properties?.sessionID ??
            event.properties?.info?.sessionID ??
            event.properties?.part?.sessionID
      if (typeof id !== "string") return
      const state = stateFor(id)
      if (!state) return
      if (
        [
          "message.part.updated",
          "message.part.removed",
          "message.removed",
          "message.updated",
        ].includes(event.type)
      ) {
        const messageID =
          event.properties?.part?.messageID ??
          event.properties?.messageID ??
          event.properties?.info?.id
        // OpenCode refreshes the current user's diff summary after each tool
        // step via message.updated. Full info events do not replace parts.
        // Ignore only metadata changes proven invisible to both the projection
        // and upstream compaction epoch; partial envelopes stay fail-closed.
        const info = event.properties?.info
        const previous = state.snapshot?.find((message) => message.info.id === messageID)
        if (options.headroom.strategy === "layered" && event.type === "message.updated" && previous && info?.id === previous.info.id &&
            info.sessionID === id && ["user", "assistant"].includes(info.role) &&
            typeof info.time?.created === "number" && Number.isFinite(info.time.created)) {
          const updated = { ...previous, info }
          const before = projectMessage(previous), after = projectMessage(updated)
          if (before && after && contentDigest(before) === contentDigest(after) &&
              upstreamEpoch([previous]) === upstreamEpoch([updated]) &&
              JSON.stringify(previous.info.error) === JSON.stringify(info.error)) {
            previous.info = structuredClone(info)
            trace(id, state, "event", "metadata-only", { type: event.type })
            if (info.time.completed) schedule(id, state)
            return
          }
        }
        const affects = (sources: string[] | undefined) =>
          sources && (typeof messageID !== "string" || sources.includes(messageID))
        if (affects(state.view?.sourceSnapshot?.messageIds ?? state.view?.replacedMessageIds)) {
          trace(id, state, "event", "ready-source", { type: event.type, hasMessageId: typeof messageID === "string" })
          // Events can precede the next authoritative transform. A view and
          // an old snapshot agreeing with each other does not prove freshness.
          delete state.snapshot
          clearView(id, state)
          return
        }
        // Layered plans bind every historical message and the current user,
        // but never modify the streaming assistant tail. Keep legacy event
        // invalidation unchanged, including snapshots with no user boundary.
        let lastUser = (state.snapshot?.length ?? 0) - 1
        while (lastUser >= 0 && state.snapshot![lastUser]!.info.role !== "user") lastUser--
        const sources = options.headroom.strategy === "layered" && lastUser >= 0
          ? state.snapshot?.slice(0, lastUser + 1)
          : state.snapshot
        const inPrefix = !!affects(sources?.map((message) => message.info.id))
        trace(id, state, "event", inPrefix ? "snapshot-source" : "outside-source", { type: event.type, hasMessageId: typeof messageID === "string", sourceCount: sources?.length ?? 0 })
        if (inPrefix) {
          // An expanding in-flight plan may cover more than the ready view.
          // Cancel its generation even when the ready prefix remains valid.
          delete state.snapshot
          delete state.attempted
          state.generation++
          return
        }
      }
      if (event.type === "session.compacted") {
        state.paused = false
        delete state.snapshot
        clearView(id, state)
        return
      }
      if (event.type === "session.deleted") {
        clearView(id, state)
        sessions.delete(id)
        return
      }
      if (
        event.type === "session.idle" ||
        (event.type === "session.status" && event.properties?.status?.type === "idle")
      ) {
        state.paused = false
        await runtime.idle(id)
      } else if (event.type === "message.updated" && event.properties?.info?.time?.completed)
        schedule(id, state)
    },
    async compacting(id: string, output: { context: string[] }) {
      const state = stateFor(id)
      if (!state || mode("headroom") === "off") return
      state.paused = true
      state.generation++
      if (
        mode("headroom") === "on" &&
        options.headroom.fallback === "upstream" &&
        state.view &&
        state.snapshot &&
        state.view.epoch === state.epoch &&
        applyHostView(structuredClone(state.snapshot), state.view) === "applied"
      ) {
        output.context.push(
          `[bluecode headroom] Archived memory:\n${state.view.summary}\nRetrieve original evidence with headroom_retrieve(historyHash="${state.view.historyHash}"); follow nextCursor.`
        )
      }
    },
    async drain() {
      while (jobs.size > 0 || queue.length > 0) await Promise.all([...jobs])
    },
    async dispose() {
      if (disposed) return
      disposed = true
      queue.length = 0
      queuedBytes = 0
      for (const state of sessions.values()) state.generation++
      await Promise.all([...jobs])
      await Promise.allSettled([input.rtk?.shutdown(), input.headroom?.close()])
      sessions.clear()
      models.clear()
    },
  }
  return runtime
}
export type PluginRuntime = ReturnType<typeof createPluginRuntime>
