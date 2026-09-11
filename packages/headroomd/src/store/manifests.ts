import {
  headroomCompressResultSchema,
  type HeadroomCompressResult,
  type Namespace,
} from "@bluecode/contracts"
import type { HeadroomDb } from "./db"
import { canonicalJSON } from "../turns"

export function initializeManifests(meta: HeadroomDb): void {
  meta.db.exec(`CREATE TABLE IF NOT EXISTS archive_manifests(
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, history_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL, plan TEXT NOT NULL, children TEXT NOT NULL,
    PRIMARY KEY(project_id, session_id, history_hash));
    CREATE TABLE IF NOT EXISTS active_views(
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, history_hash TEXT NOT NULL,
    plan TEXT,
    PRIMARY KEY(project_id, session_id));`)
  const columns = meta.db.prepare("PRAGMA table_info(active_views)").all() as Array<{
    name: string
  }>
  if (!columns.some((column) => column.name === "plan"))
    meta.db.exec("ALTER TABLE active_views ADD COLUMN plan TEXT")
  meta.db.exec(`UPDATE active_views SET plan=(SELECT plan FROM archive_manifests a
    WHERE a.project_id=active_views.project_id AND a.session_id=active_views.session_id AND a.history_hash=active_views.history_hash)
    WHERE plan IS NULL`)
}
export function saveManifest(
  meta: HeadroomDb,
  ns: Namespace,
  plan: HeadroomCompressResult,
  children: string[]
): void {
  if (!plan.compacted || !plan.historyHash || !plan.sourceDigests)
    throw new Error("Only complete versioned plans can be published")
  headroomCompressResultSchema.parse(plan)
  meta.db
    .prepare(
      `INSERT INTO archive_manifests VALUES(?, ?, ?, 3, ?, ?)
    ON CONFLICT(project_id, session_id, history_hash) DO UPDATE SET schema_version=excluded.schema_version, plan=excluded.plan, children=excluded.children`
    )
    .run(
      ns.projectId,
      ns.sessionId,
      plan.historyHash,
      JSON.stringify(plan),
      JSON.stringify([...new Set(children)])
    )
}
export function getManifest(
  meta: HeadroomDb,
  ns: Namespace,
  hash: string
): HeadroomCompressResult | null {
  const row = meta.db
    .prepare(
      "SELECT plan FROM archive_manifests WHERE project_id=? AND session_id=? AND history_hash=?"
    )
    .get(ns.projectId, ns.sessionId, hash) as { plan: string } | null
  if (!row) return null
  return headroomCompressResultSchema.parse(JSON.parse(row.plan))
}
export function getView(meta: HeadroomDb, ns: Namespace): HeadroomCompressResult | null {
  const row = meta.db
    .prepare("SELECT plan FROM active_views WHERE project_id=? AND session_id=?")
    .get(ns.projectId, ns.sessionId) as { plan: string | null } | null
  return row?.plan ? headroomCompressResultSchema.parse(JSON.parse(row.plan)) : null
}
export function setView(meta: HeadroomDb, ns: Namespace, plan: HeadroomCompressResult): void {
  const stored = plan.historyHash ? getManifest(meta, ns, plan.historyHash) : null
  // Analysis cache counters change on an identical replay; they are telemetry,
  // not authority to alter the confirmed source or replacement content.
  const comparable = (value: HeadroomCompressResult) => {
    const { metrics, enhancementJobId, ...content } = headroomCompressResultSchema.parse(value)
    return canonicalJSON(content)
  }
  if (
    !stored ||
    comparable(stored) !== comparable(plan)
  ) {
    throw new Error("View must match a confirmed archive in its namespace")
  }
  meta.db
    .prepare(
      "INSERT INTO active_views(project_id,session_id,history_hash,plan) VALUES(?, ?, ?, ?) ON CONFLICT(project_id, session_id) DO UPDATE SET history_hash=excluded.history_hash,plan=excluded.plan"
    )
    .run(
      ns.projectId,
      ns.sessionId,
      plan.historyHash,
      JSON.stringify(headroomCompressResultSchema.parse(plan))
    )
}
export function clearView(meta: HeadroomDb, ns: Namespace): void {
  meta.db
    .prepare("DELETE FROM active_views WHERE project_id=? AND session_id=?")
    .run(ns.projectId, ns.sessionId)
}
