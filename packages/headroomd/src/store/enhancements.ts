import { headroomCompressResultSchema, type HeadroomCompressResult, type Namespace, type GetCandidateResult } from "@bluecode/contracts"
import type { HeadroomDb } from "./db"

export interface EnhancementJobRecord {
  jobId: string
  sourceKey: string
  nodeId: string
  base: HeadroomCompressResult
  candidate: HeadroomCompressResult | null
  status: "queued" | "running" | "ready" | "rejected"
  reason?: string
  telemetry?: Pick<GetCandidateResult, "usage" | "reservedUsage" | "model">
}
export function initializeEnhancements(meta: HeadroomDb): void {
  meta.db.exec(`CREATE TABLE IF NOT EXISTS enhancement_jobs(
    job_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
    source_key TEXT NOT NULL, node_id TEXT NOT NULL, base_plan TEXT NOT NULL,
    candidate TEXT, status TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS enhancement_session ON enhancement_jobs(project_id,session_id);
    CREATE TABLE IF NOT EXISTS summary_usage(
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    PRIMARY KEY(project_id,session_id));
    UPDATE enhancement_jobs SET status='rejected', reason='Daemon restarted before summary completion'
      WHERE status IN ('queued','running');`)
  const columns = meta.db.prepare("PRAGMA table_info(enhancement_jobs)").all() as Array<{ name: string }>
  if (!columns.some(column => column.name === "telemetry")) meta.db.exec("ALTER TABLE enhancement_jobs ADD COLUMN telemetry TEXT")
}

export function saveEnhancementJob(meta: HeadroomDb, ns: Namespace, job: EnhancementJobRecord): void {
  meta.db.prepare(`INSERT INTO enhancement_jobs(job_id,project_id,session_id,source_key,node_id,base_plan,candidate,status,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING`)
    .run(job.jobId, ns.projectId, ns.sessionId, job.sourceKey, job.nodeId, JSON.stringify(job.base),
      job.candidate ? JSON.stringify(job.candidate) : null, job.status, job.reason ?? null, Date.now())
  meta.db.exec(`DELETE FROM enhancement_jobs WHERE job_id IN (
    SELECT job_id FROM enhancement_jobs WHERE status IN ('ready','rejected')
    ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 256)`)
}

export function getEnhancementJob(meta: HeadroomDb, ns: Namespace, id: string): EnhancementJobRecord | null {
  const row = meta.db.prepare("SELECT * FROM enhancement_jobs WHERE job_id=? AND project_id=? AND session_id=?")
    .get(id, ns.projectId, ns.sessionId) as Record<string, string | null> | null
  if (!row) return null
  return { jobId: id, sourceKey: row.source_key!, nodeId: row.node_id!,
    base: headroomCompressResultSchema.parse(JSON.parse(row.base_plan!)),
    candidate: row.candidate ? headroomCompressResultSchema.parse(JSON.parse(row.candidate)) : null,
    status: row.status as EnhancementJobRecord["status"], ...(row.reason ? { reason: row.reason } : {}), ...(row.telemetry ? { telemetry: JSON.parse(row.telemetry) } : {}) }
}

export function updateEnhancementJob(meta: HeadroomDb, ns: Namespace, id: string, status: EnhancementJobRecord["status"], candidate: HeadroomCompressResult | null, reason?: string): void {
  meta.db.prepare("UPDATE enhancement_jobs SET status=?,candidate=?,reason=? WHERE job_id=? AND project_id=? AND session_id=?")
    .run(status, candidate ? JSON.stringify(headroomCompressResultSchema.parse(candidate)) : null, reason ?? null, id, ns.projectId, ns.sessionId)
}

export function rejectSessionEnhancements(meta: HeadroomDb, ns: Namespace): string[] {
  const ids = (meta.db.prepare("SELECT job_id FROM enhancement_jobs WHERE project_id=? AND session_id=? AND status IN ('queued','running')")
    .all(ns.projectId, ns.sessionId) as Array<{ job_id: string }>).map((row) => row.job_id)
  meta.db.prepare("UPDATE enhancement_jobs SET status='rejected',reason='Source history invalidated' WHERE project_id=? AND session_id=?")
    .run(ns.projectId, ns.sessionId)
  return ids
}

export function saveSummaryUsage(meta: HeadroomDb, ns: Namespace, usage: { inputTokens: number; outputTokens: number }): void {
  meta.db.prepare("INSERT INTO summary_usage VALUES(?,?,?,?) ON CONFLICT(project_id,session_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens")
    .run(ns.projectId, ns.sessionId, usage.inputTokens, usage.outputTokens)
}
export function loadSummaryUsage(meta: HeadroomDb): Array<{ projectId: string; sessionId: string; inputTokens: number; outputTokens: number }> {
  return meta.db.prepare("SELECT project_id AS projectId,session_id AS sessionId,input_tokens AS inputTokens,output_tokens AS outputTokens FROM summary_usage").all() as Array<{ projectId: string; sessionId: string; inputTokens: number; outputTokens: number }>
}

export function saveEnhancementTelemetry(meta: HeadroomDb, ns: Namespace, id: string, telemetry: EnhancementJobRecord["telemetry"]): void {
  meta.db.prepare("UPDATE enhancement_jobs SET telemetry=? WHERE job_id=? AND project_id=? AND session_id=?")
    .run(JSON.stringify(telemetry), id, ns.projectId, ns.sessionId)
}
