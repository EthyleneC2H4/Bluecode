import type { ChatMessage, GetCandidateParams, GetCandidateResult, HeadroomCompressResult, Namespace, SummaryProviderConfig } from "@bluecode/contracts"
import { EnhancementManager } from "./enhancement"
import { OpenAICompatibleSummaryProvider } from "./summary-provider"
import { buildEnhancedCandidate } from "./enhanced-candidate"
import type { TokenCounter } from "./token-counter"
import { linkHistoryMeta, type HeadroomDb } from "./store/db"
import { readNode, saveNodes } from "./store/nodes"
import { readMessageObject } from "./store/objects"
import { saveManifest } from "./store/manifests"
import { saveEnhancementTelemetry, getEnhancementJob, initializeEnhancements, loadSummaryUsage, rejectSessionEnhancements, saveEnhancementJob, saveSummaryUsage, updateEnhancementJob } from "./store/enhancements"

/** The coordinator performs only local work. Provider promises never enter the engine's serial queue. */
export function createEnhancementCoordinator(meta: HeadroomDb, dataDir: string, config: SummaryProviderConfig | undefined, counter: TokenCounter) {
  initializeEnhancements(meta)
  const manager = config?.enabled ? new EnhancementManager(new OpenAICompatibleSummaryProvider(config), config, counter) : null
  const namespaces = new Map<string, Namespace>()
  for (const usage of loadSummaryUsage(meta)) {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) continue
    const ns = { projectId: usage.projectId, sessionId: usage.sessionId }
    manager?.restoreUsage(ns, usage)
    namespaces.set(JSON.stringify(ns), ns)
  }
  const persist = (ns: Namespace) => {
    if (!manager) return
    const usage = manager.sessionUsage(ns)
    if (usage.inputTokens === 0 && usage.outputTokens === 0 && !namespaces.has(JSON.stringify(ns))) return
    namespaces.set(JSON.stringify(ns), ns)
    saveSummaryUsage(meta, ns, usage)
  }
  const reject = (ns: Namespace, jobId: string, reason: string): GetCandidateResult => {
    manager?.cancel(jobId)
    updateEnhancementJob(meta, ns, jobId, "rejected", null, reason)
    persist(ns)
    return { status: "rejected", candidate: null, reason }
  }
  return {
    prepare(ns: Namespace, messages: readonly ChatMessage[], base: HeadroomCompressResult): string | undefined {
      if (!manager || !base.compacted || !base.historyHash || !base.budget?.historyBudgetTokens || !base.operations?.length ||
          (!base.budgetExceeded && (base.metrics?.candidateCount ?? 0) <= (base.metrics?.selectedMemoryBlocks ?? 0))) return
      const byId = new Map(messages.map(message => [message.info.id, message]))
      const visible = new Set(base.operations.map(operation => operation.nodeId))
      // Only optional notes already present in the rule view can yield an immediate net improvement.
      const candidates = (base.nodes ?? []).filter(node => visible.has(node.nodeId) && !node.children.length &&
        !node.stateEvents?.some(event => event.kind === "failures" || event.kind === "constraints") &&
        (base.memory ?? []).some(entry => entry.sourceIds.some(id => node.sourceRefs.some(ref => ref.messageId === id))))
      for (const node of candidates.slice(0, 16)) {
        const sourceIds = [...new Set(node.sourceRefs.map(ref => ref.messageId))]
        if (base.taskState?.events.some(event => event.kind === "failures" && event.sourceIds.some(id => sourceIds.includes(id)))) continue
        const material: string[] = []
        for (const ref of node.sourceRefs) {
          const message = byId.get(ref.messageId), part = message?.parts[ref.partIndex ?? 0]
          if (!part) continue
          const raw = part.type === "text" ? part.text : part.state.output ?? part.state.error ?? ""
          material.push(JSON.stringify({ sourceId: ref.messageId, contentHash: ref.contentHash,
            ...(part.type === "tool" ? { tool: part.tool, input: part.input, status: part.state.status } : {}),
            content: raw.slice(ref.start ?? 0, ref.end ?? raw.length) }))
        }
        const job = manager.submit({ namespace: ns, sourceKey: base.historyHash, sourceIds, material: material.join("\n"), state: node.stateEvents })
        if (!job.jobId) { if (job.reason === "input-budget") continue; return }
        // Reservation is durable before the provider microtask starts; a crash cannot replenish the budget.
        persist(ns)
        saveEnhancementJob(meta, ns, { jobId: job.jobId, sourceKey: base.historyHash, nodeId: node.nodeId, base, candidate: null, status: "queued" })
        return job.jobId
      }
    },
    async candidate(params: GetCandidateParams): Promise<GetCandidateResult> {
      const ns = params.namespace, record = getEnhancementJob(meta, ns, params.jobId)
      if (!record) return { status: "missing", candidate: null }
      const snapshot = record.base.sourceSnapshot
      if (params.epoch !== record.base.epoch || !params.sourceDigests || !snapshot ||
          snapshot.sourceDigests.some((digest, index) => digest !== params.sourceDigests![index]))
        return reject(ns, params.jobId, "Source history changed")
      if (record.status === "rejected") return { status: "rejected", candidate: null, ...(record.reason ? { reason: record.reason } : {}) }
      if (record.status === "ready") return { status: "ready", candidate: record.candidate, ...record.telemetry }
      const job = manager?.get(params.jobId, record.sourceKey)
      if (!job || job.status === "failed" || job.status === "cancelled" || job.status === "rejected")
        return reject(ns, params.jobId, job?.reason ?? "Summary job is unavailable")
      persist(ns)
      const usage = { model: config!.model!, ...(job.usage ? { usage: job.usage } : {}), reservedUsage: manager!.sessionUsage(ns) }
      saveEnhancementTelemetry(meta, ns, params.jobId, usage)
      if (job.status !== "completed") return { status: job.status, candidate: null, ...usage }
      const node = readNode(meta, ns, record.nodeId)
      if (!node || !job.entries) return reject(ns, params.jobId, "Summary evidence is unavailable")
      const messages: ChatMessage[] = []
      const seen = new Set<string>()
      for (const ref of node.sourceRefs) {
        if (seen.has(ref.messageId)) continue
        seen.add(ref.messageId)
        const raw = await readMessageObject(dataDir, ref.contentHash)
        if (!raw || raw.info.id !== ref.messageId) return reject(ns, params.jobId, "Summary evidence is unavailable")
        messages.push(raw)
      }
      if (getEnhancementJob(meta, ns, params.jobId)?.status === "rejected") return reject(ns, params.jobId, "Source history invalidated")
      const built = buildEnhancedCandidate(record.base, node, job.entries, messages, config!.model!, counter)
      if (!built) return reject(ns, params.jobId, "Summary did not improve the bounded rule view")
      meta.db.transaction(() => {
        saveNodes(meta, ns, [built.node])
        linkHistoryMeta(meta, ns, record.base.historyHash!, built.plan.historyHash!)
        saveManifest(meta, ns, built.plan, [record.base.historyHash!])
        updateEnhancementJob(meta, ns, params.jobId, "ready", built.plan)
      })()
      return { status: "ready", candidate: built.plan, ...usage }
    },
    invalidate(ns: Namespace) {
      for (const id of rejectSessionEnhancements(meta, ns)) manager?.cancel(id)
      persist(ns)
    },
    close() {
      manager?.dispose()
      for (const ns of namespaces.values()) persist(ns)
    },
  }
}
