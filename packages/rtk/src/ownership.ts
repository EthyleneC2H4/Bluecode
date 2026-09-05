/** Durable session ownership for canonical rtk CAS objects. */
import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { objectPath } from "@bluecode/shared"

export interface OwnershipStore {
  /** Cross-process publication lock; crashes release it through SQLite. */
  publish<T>(work: () => Promise<T>): Promise<T>
  reserve(hash: string, size: number, limit: number): boolean
  grant(sessionId: string, hash: string): void
  owns(sessionId: string, hash: string): boolean
  close(): void
}

export function openOwnershipStore(dataDir: string): OwnershipStore {
  const db = new Database(`${dataDir}/rtk-meta.db`, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = FULL")
  db.exec("PRAGMA busy_timeout = 50")
  db.exec(`
    CREATE TABLE IF NOT EXISTS rtk_refs (
      session_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, hash)
    )
  `)
  db.exec(`CREATE TABLE IF NOT EXISTS rtk_storage(hash TEXT PRIMARY KEY, size INTEGER NOT NULL)`)
  db.transaction(() => {
    if (
      !(db.query("PRAGMA table_info(rtk_storage)").all() as Array<{ name: string }>).some(
        (column) => column.name === "state"
      )
    )
      db.exec("ALTER TABLE rtk_storage ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'")
  }).immediate()
  // A separate rollback-journal connection holds the OS-backed mutex across
  // asynchronous CAS I/O. The WAL ledger still durably commits reservations
  // BEFORE publication, so a crash after link cannot create uncounted bytes.
  const writer = new Database(`${dataDir}/rtk-writer.db`, { create: true })
  writer.exec("PRAGMA busy_timeout = 50")
  function reconcilePending(): void {
    const pending = db.query("SELECT hash FROM rtk_storage WHERE state='pending'").all() as Array<{
      hash: string
    }>
    db.transaction(() => {
      for (const { hash } of pending) {
        try {
          statSync(objectPath(dataDir, hash))
          db.query("UPDATE rtk_storage SET state='published' WHERE hash=?").run(hash)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          db.query("DELETE FROM rtk_storage WHERE hash=? AND state='pending'").run(hash)
        }
      }
    }).immediate()
  }
  const reserve = db.transaction((hash: string, size: number, limit: number) => {
    const existing = db.query("SELECT size FROM rtk_storage WHERE hash=?").get(hash) as {
      size: number
    } | null
    if (existing) return existing.size === size
    const usage = (
      db.query("SELECT COALESCE(SUM(size),0) AS bytes FROM rtk_storage").get() as { bytes: number }
    ).bytes
    if (usage + size > limit) return false
    db.query("INSERT INTO rtk_storage(hash,size) VALUES (?,?)").run(hash, size)
    return true
  })

  const grant = db.prepare(
    `INSERT OR IGNORE INTO rtk_refs(session_id, hash, created_at) VALUES (?, ?, ?)`
  )
  const owns = db.prepare(`SELECT 1 AS present FROM rtk_refs WHERE session_id = ? AND hash = ?`)

  return {
    async publish(work) {
      writer.exec("BEGIN EXCLUSIVE")
      try {
        // No publisher can be active while this mutex is held. Missing
        // pending objects are abandoned, never another writer's in-flight CAS.
        reconcilePending()
        return await work()
      } finally {
        try {
          reconcilePending()
        } finally {
          writer.exec("ROLLBACK")
        }
      }
    },
    reserve: (hash, size, limit) => reserve.immediate(hash, size, limit),
    grant(sessionId, hash): void {
      grant.run(sessionId, hash, Date.now())
    },
    owns(sessionId, hash): boolean {
      return owns.get(sessionId, hash) !== null
    },
    close(): void {
      writer.close()
      db.close()
    },
  }
}
