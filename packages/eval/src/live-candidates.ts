import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
const reasons: Record<string, string> = {
  "Summary did not improve the bounded rule view": "not-improved",
  "Source history changed": "source-changed", "Source history invalidated": "source-invalidated",
  "Summary job is unavailable": "job-unavailable", "Summary evidence is unavailable": "evidence-unavailable",
  "Daemon restarted before summary completion": "daemon-restarted",
}
export function candidateObservation(row: any, visibleNodes: string[]) {
  const old = new Set<string>((row.base?.operations ?? []).map((operation: any) => operation.nodeId))
  const novel = (row.candidate?.operations ?? []).map((operation: any) => operation.nodeId).filter((id: unknown): id is string => typeof id === "string" && !old.has(id))
  const applied = novel.length > 0 && novel.every((id: string) => visibleNodes.includes(id))
  return { jobId: row.jobId ?? null, status: row.status === "rejected" ? "rejected" : applied ? "applied" : ["queued", "running", "ready", "rejected"].includes(row.status) ? row.status : "unknown",
    queued: true, ready: Boolean(row.candidate), rejected: row.status === "rejected", applied,
    reasonCode: row.reason ? reasons[row.reason] ?? "unclassified-rejection" : null }
}
/** Read only the evaluation's private database; never reopen an engine or print plans. */
export function readCandidates(path: string, sessionId: string, visibleNodes: string[]) {
  if (!existsSync(path)) return { complete: false, reasonCode: "database-unavailable", jobs: [] }
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    const rows = db.query("SELECT job_id, status, reason, base_plan, candidate FROM enhancement_jobs WHERE session_id=?").all(sessionId) as any[]
    const jobs = rows.map(row => candidateObservation({ jobId: row.job_id, status: row.status, reason: row.reason, base: JSON.parse(row.base_plan), candidate: row.candidate ? JSON.parse(row.candidate) : null }, visibleNodes))
    return { complete: jobs.every(job => !["queued", "running", "unknown"].includes(job.status)), reasonCode: null, jobs }
  } catch { return { complete: false, reasonCode: "candidate-state-unavailable", jobs: [] } }
  finally { db?.close() }
}
