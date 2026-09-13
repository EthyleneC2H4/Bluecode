/** Offline 0–4 retained-turn sweep. Overwrites only packages/eval/retention-results; no provider calls. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { runEvaluation } from "../packages/eval/src/runner"
import { aggregateReport } from "../packages/eval/src/metrics"
import { validateReliability, validateReplayConsistency } from "../packages/eval/src/reliability"
import { allFixtures } from "../packages/eval/src/fixtures"
import { runHeadroomEvaluation } from "../packages/eval/src/headroom-runner"
import { headroomFixtures } from "../packages/eval/src/headroom-fixtures"

const directory = "packages/eval/retention-results"
await mkdir(directory, { recursive: true })
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const revision = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout).trim()
const sourceDiff = new TextDecoder().decode(Bun.spawnSync(["git", "diff", "HEAD", "--", "packages/*/src/**", "scripts/*.ts", "package.json", "bun.lock"]).stdout)
const manifest: any = { codeRevision: revision, timestamp: new Date().toISOString(), externalModelCalls: 0,
  sourceDirty: sourceDiff.length > 0, sourceDiffSha256: hash(sourceDiff), driverSha256: hash(await readFile(new URL(import.meta.url), "utf8")),
  fixtureSha256: hash(JSON.stringify(allFixtures())), dedicatedFixtureSha256: hash(JSON.stringify(headroomFixtures())),
  retentionOrder: [4, 3, 2, 1, 0], settings: { strategy: "layered", memoryMaxTokens: 4096, memoryRatio: 0.15,
    triggerRatio: 0.7, targetRatio: 0.55, summarizerEnabled: false, contextWindowTokens: 8192,
    outputReserve: 1024, replaySteps: 4, hostCallsPerStage: 2, rtkBudgetTokens: 512, rtkTimeoutMs: 40,
    retrievalMaxTokens: 8192, retrievalMaxBytes: 32768 }, reports: [] }
async function save(file: string, result: unknown, details: object) {
  const text = JSON.stringify(result, null, 2) + "\n"
  await writeFile(`${directory}/${file}`, text)
  manifest.reports.push({ file, sha256: hash(text), ...details })
  await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n")
}
for (const retrievalStrategy of ["query-only", "eager-recovery"] as const) {
  for (const retainRecentTurns of manifest.retentionOrder) {
    const result = await runEvaluation({ headroomStrategy: "layered", retainRecentTurns, retrievalStrategy })
    const report = aggregateReport(result.perFixture, result.latencies, result.recallResults)
    const violations = validateReliability(report)
    if (validateReplayConsistency(report).length) throw new Error("Invalid replay accounting")
    const groups = Object.fromEntries(Object.entries(report.groups).map(([group, row]) => [group, {
      input: row.replay!.totalInputTokens, retrieval: row.replay!.retrievalOutputTokens,
      tasks: row.replay!.tasks, critical: row.replay!.critical, recall: row.replay!.naturalRecallAt5,
      archive: row.archiveRecovery, contextRecall: row.contextRecall,
    }]))
    await save(`${retrievalStrategy}-${retainRecentTurns}.json`, report, { suite: "ablation", retrievalStrategy, retainRecentTurns, violations, groups })
    console.log(JSON.stringify({ suite: "ablation", retrievalStrategy, retainRecentTurns, groups, violations }))
  }
}
for (const retainRecentTurns of manifest.retentionOrder) {
  const result = await runHeadroomEvaluation({ strategies: ["layered"], retainRecentTurns,
    onProgress: fixture => console.error(`[retention:${retainRecentTurns}] ${fixture}`) })
  const rows = result.comparisons.map(c => c.layered)
  const failed = result.comparisons.filter(c => c.layered.status !== "completed" ||
    c.layered.quality.constraintsFound !== c.layered.quality.constraintsTotal || !c.layered.quality.sourceRecovered ||
    !c.layered.quality.protectedMessagesIntact || !c.layered.quality.naturalEvidenceFound).map(c => c.name)
  const summary = { input: rows.reduce((n, r) => n + r.cumulativeInputTokens, 0),
    retrieval: rows.reduce((n, r) => n + r.retrievalTokens, 0), cpuSeconds: rows.reduce((n, r) => n + (r.daemon.cpuSeconds ?? 0), 0),
    daemonRssPeakBytes: Math.max(...rows.map(r => r.daemon.rssPeakBytes)), cases: rows.length, failed }
  await save(`dedicated-${retainRecentTurns}.json`, result, { suite: "dedicated", retainRecentTurns, summary })
  console.log(JSON.stringify({ suite: "dedicated", retainRecentTurns, ...summary }))
}
