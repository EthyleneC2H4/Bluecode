import { randomUUID } from "node:crypto"
import type { Namespace } from "@bluecode/contracts"
import type { HeadroomDb } from "./db"
import type { HistoryFrontier } from "../history-reader"

const CAP = 4096
export function initializeHistoryCursors(meta: HeadroomDb): void {
  meta.db.exec(`CREATE TABLE IF NOT EXISTS history_cursors(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
    history_hash TEXT NOT NULL, frontier TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS history_cursor_age ON history_cursors(created_at);`)
}

export function saveHistoryCursor(meta: HeadroomDb, ns: Namespace, hash: string, frontier: HistoryFrontier): string {
  const id = `h3-${randomUUID()}`
  meta.db.transaction(() => {
    meta.db.prepare("INSERT INTO history_cursors VALUES(?,?,?,?,?,?)")
      .run(id, ns.projectId, ns.sessionId, hash, JSON.stringify(frontier), Date.now())
    meta.db.prepare("DELETE FROM history_cursors WHERE id IN (SELECT id FROM history_cursors ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)").run(CAP)
  })()
  return id
}

export function loadHistoryCursor(meta: HeadroomDb, ns: Namespace, hash: string, id: string): HistoryFrontier {
  const row = meta.db.prepare("SELECT frontier FROM history_cursors WHERE id=? AND project_id=? AND session_id=? AND history_hash=?")
    .get(id, ns.projectId, ns.sessionId, hash) as { frontier: string } | null
  if (!row) throw new Error("History cursor expired or does not match reference; restart retrieval")
  return JSON.parse(row.frontier) as HistoryFrontier
}
