/** Deterministic replay proxy, not provider usage or an agent solving tasks. */
export interface ReplayMetrics {
  adapter: "@bluecode/plugin/runtime"
  retrievalStrategy: "query-only" | "eager-recovery"
  /** Actual runtime configuration and persisted view, not just a requested CLI label. */
  headroom?: {
    strategy: "legacy" | "layered"
    activeViewStrategy: "legacy" | "layered" | null
    memoryMaxTokens: number
    memoryRatio: number
    summarizerEnabled: boolean
  }
  modelCalls: Array<{ phase: "host" | "retrieval"; inputTokens: number; retrievalTokens: number }>
  totalInputTokens: number
  retrievalOutputTokens: number
  critical: { found: number; total: number }
  naturalRecallAt5: { found: number; total: number; misses: string[] }
  tasks: { passed: number; total: number; failures: string[] }
  violations: { crossNamespace: number; stalePlan: number; retrievalRecompression: number }
  probes: { crossNamespace: number; stalePlan: number; retrievalRecompression: number }
  runtime: { rtkCalls: number; plans: number; applied: number; errors: number }
  latency: {
    toolHookMs: number
    transformMs: number
    planningDrainMs: number
    retrievalMs: number
    archiveProbeMs: number
    queueMs: null
    serviceMs: null
    deadlineMs: number
  }
  rssBytes: number
}
export interface ReplayAggregate {
  totalInputTokens: number
  retrievalOutputTokens: number
  modelCalls: number
  critical: { found: number; total: number; rate: number }
  naturalRecallAt5: { found: number; total: number; rate: number | null }
  tasks: { passed: number; total: number; rate: number | null }
  violations: ReplayMetrics["violations"]
  probes: ReplayMetrics["probes"]
  peakObservedRssBytes: number
}
export function aggregateReplay(rows: ReplayMetrics[]): ReplayAggregate | undefined {
  if (rows.length === 0) return undefined
  const sum = (fn: (r: ReplayMetrics) => number) => rows.reduce((n, r) => n + fn(r), 0)
  const critical = { found: sum((r) => r.critical.found), total: sum((r) => r.critical.total) }
  const natural = {
    found: sum((r) => r.naturalRecallAt5.found),
    total: sum((r) => r.naturalRecallAt5.total),
  }
  const tasks = { passed: sum((r) => r.tasks.passed), total: sum((r) => r.tasks.total) }
  return {
    totalInputTokens: sum((r) => r.totalInputTokens),
    retrievalOutputTokens: sum((r) => r.retrievalOutputTokens),
    modelCalls: sum((r) => r.modelCalls.length),
    critical: { ...critical, rate: critical.total ? critical.found / critical.total : 1 },
    naturalRecallAt5: { ...natural, rate: natural.total ? natural.found / natural.total : null },
    tasks: { ...tasks, rate: tasks.total ? tasks.passed / tasks.total : null },
    violations: {
      crossNamespace: sum((r) => r.violations.crossNamespace),
      stalePlan: sum((r) => r.violations.stalePlan),
      retrievalRecompression: sum((r) => r.violations.retrievalRecompression),
    },
    probes: {
      crossNamespace: sum((r) => r.probes.crossNamespace),
      stalePlan: sum((r) => r.probes.stalePlan),
      retrievalRecompression: sum((r) => r.probes.retrievalRecompression),
    },
    peakObservedRssBytes: Math.max(...rows.map((r) => r.rssBytes)),
  }
}
