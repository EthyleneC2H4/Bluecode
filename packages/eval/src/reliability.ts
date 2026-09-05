import type { FullReport } from "./metrics"
import { aggregateReplay, type ReplayMetrics } from "./replay-metrics"
export interface ReliabilityViolation {
  metric: string
  group: string
  target: string
  current: number | null
}
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
const pair = (found: unknown, total: unknown) => count(found) && count(total) && found <= total

/** Recompute every replay aggregate from rows; supplied success summaries are not evidence. */
export function validateReplayConsistency(report: FullReport): ReliabilityViolation[] {
  const violations: ReliabilityViolation[] = []
  const add = (metric: string, group: string) =>
    violations.push({
      metric,
      group,
      target: "valid per-row counts and exact aggregation",
      current: null,
    })
  const compare = (actual: any, expected: any, prefix: string, group: string) => {
    if (expected !== null && typeof expected === "object") {
      for (const [key, value] of Object.entries(expected))
        compare(actual?.[key], value, `${prefix}.${key}`, group)
    } else if (!Object.is(actual, expected)) add(prefix, group)
  }
  for (const group of ["A", "B", "C", "D"] as const) {
    const rows = report.perFixture.filter((row) => row.group === group)
    // Pre-replay baselines remain valid for relative comparison only.
    if (!report.groups[group]?.replay && rows.every((row) => !row.replay)) continue
    const valid: ReplayMetrics[] = []
    for (const row of rows) {
      const r = row.replay,
        label = `${group}:${row.fixture}`
      if (
        !r ||
        !pair(r.critical?.found, r.critical?.total) ||
        !pair(r.tasks?.passed, r.tasks?.total) ||
        !pair(r.naturalRecallAt5?.found, r.naturalRecallAt5?.total) ||
        !pair(row.archiveRecoveryFound, row.archiveRecoveryTotal) ||
        !count(r.totalInputTokens) ||
        !count(r.retrievalOutputTokens) ||
        !count(r.rssBytes) ||
        !Array.isArray(r.modelCalls) ||
        r.modelCalls.some(
          (call) =>
            !["host", "retrieval"].includes(call.phase) ||
            !count(call.inputTokens) ||
            !count(call.retrievalTokens) ||
            call.retrievalTokens > call.inputTokens ||
            (call.phase === "host" && call.retrievalTokens !== 0)
        ) ||
        ["crossNamespace", "stalePlan", "retrievalRecompression"].some(
          (key) =>
            !count(r.violations?.[key as keyof typeof r.violations]) ||
            !count(r.probes?.[key as keyof typeof r.probes])
        )
      ) {
        add("row.replay.shape", label)
        continue
      }
      valid.push(r)
      if (r.modelCalls.reduce((n, call) => n + call.inputTokens, 0) !== r.totalInputTokens)
        add("row.modelInputAccounting", label)
      if (r.modelCalls.reduce((n, call) => n + call.retrievalTokens, 0) !== r.retrievalOutputTokens)
        add("row.retrievalOutputAccounting", label)
      if (
        !Array.isArray(r.tasks.failures) ||
        r.tasks.failures.length !== r.tasks.total - r.tasks.passed
      )
        add("row.taskFailures", label)
      if (
        !Array.isArray(r.naturalRecallAt5.misses) ||
        r.naturalRecallAt5.misses.length !== r.naturalRecallAt5.total - r.naturalRecallAt5.found
      )
        add("row.queryMisses", label)
    }
    if (valid.length !== rows.length || !valid.length) {
      add("aggregate.replay.rows", group)
      continue
    }
    compare(report.groups[group]?.replay, aggregateReplay(valid), "aggregate.replay", group)
    const found = rows.reduce((n, row) => n + row.archiveRecoveryFound, 0)
    const total = rows.reduce((n, row) => n + row.archiveRecoveryTotal, 0)
    compare(
      report.groups[group]?.archiveRecovery,
      { found, total, rate: total ? found / total : 1 },
      "aggregate.archiveRecovery",
      group
    )
  }
  return violations
}

/** Absolute targets do not inherit a weak historical baseline, and cannot be skipped. */
export function validateReliability(report: FullReport): ReliabilityViolation[] {
  const violations: ReliabilityViolation[] = validateReplayConsistency(report)
  const add = (metric: string, group: string, target: string, current: number | null) =>
    violations.push({ metric, group, target, current })
  for (const group of ["A", "B", "C", "D"] as const) {
    const metrics = report.groups[group],
      replay = metrics.replay
    if (!replay?.critical || !replay.tasks || !replay.naturalRecallAt5 || !replay.violations) {
      add("replay.missing", group, "complete real plugin replay required", null)
      continue
    }
    if (!replay.critical.total || replay.critical.found !== replay.critical.total)
      add("criticalPreservation", group, "100%, nonempty", replay.critical.rate)
    if (!replay.tasks.total || replay.tasks.passed !== replay.tasks.total)
      add("deterministicTasks", group, "100%, nonempty", replay.tasks.rate)
    if (
      group !== "A" &&
      (!metrics.archiveRecovery.total ||
        metrics.archiveRecovery.found !== metrics.archiveRecovery.total)
    )
      add("archiveEquality", group, "100%, nonempty", metrics.archiveRecovery.rate)
    for (const key of ["crossNamespace", "stalePlan", "retrievalRecompression"] as const) {
      if (replay.violations[key] !== 0) add(key, group, "0", replay.violations[key])
    }
    const naturalRate =
      replay.naturalRecallAt5.total > 0
        ? replay.naturalRecallAt5.found / replay.naturalRecallAt5.total
        : null
    if (["C", "D"].includes(group) && (naturalRate === null || naturalRate < 0.9))
      add("naturalRecallAt5", group, ">=90%, nonempty", naturalRate)
    const rows = report.perFixture.filter((row) => row.group === group)
    for (const row of rows) {
      const r = row.replay,
        label = `${group}:${row.fixture}`
      if (!r) continue
      if (r.critical?.found !== r.critical?.total)
        add("criticalPreservation", label, "100% on every measured fixture", null)
      if (r.tasks?.passed !== r.tasks?.total)
        add("deterministicTasks", label, "100% on every measured fixture", null)
      if (row.archiveRecoveryFound !== row.archiveRecoveryTotal)
        add("archiveEquality", label, "100% on every archived fixture", null)
      if (
        (r.naturalRecallAt5?.total ?? 0) > 0 &&
        r.naturalRecallAt5.found / r.naturalRecallAt5.total < 0.9
      )
        add(
          "naturalRecallAt5",
          label,
          ">=90% on every queried fixture",
          r.naturalRecallAt5.found / r.naturalRecallAt5.total
        )
      for (const key of ["crossNamespace", "stalePlan", "retrievalRecompression"] as const)
        if (r.violations?.[key] !== 0)
          add(key, label, "0 on every fixture", r.violations?.[key] ?? null)
    }

    for (const probe of ["crossNamespace", "stalePlan", "retrievalRecompression"] as const) {
      const required =
        group === "C" || group === "D" || (group === "B" && probe === "crossNamespace")
      if (required && !rows.reduce((n, row) => n + (row.replay?.probes?.[probe] ?? 0), 0))
        add(`${probe}.unmeasured`, group, "nonempty real probes", 0)
    }
    if (
      rows.reduce((n, row) => n + (row.replay?.totalInputTokens ?? 0), 0) !==
      replay.totalInputTokens
    )
      add(
        "modelInputTotal",
        group,
        "group total matches per-fixture calls",
        replay.totalInputTokens
      )
  }
  const a = report.groups.A.replay?.totalInputTokens,
    d = report.groups.D.replay?.totalInputTokens
  if (!a || d === undefined || d / a > 0.8)
    add(
      "combinedNetInput",
      "D",
      ">=20% reduction against A at the same deterministic task quality",
      a && d !== undefined ? 1 - d / a : null
    )
  return violations
}
