/** SQLite holds an OS-backed exclusive lock; a crash releases it automatically. */
import { Database } from "bun:sqlite"
import path from "node:path"

/** Only lock contention permits server startup to wait for an existing writer. */
export class HeadroomWriterBusyError extends Error {
  constructor(cause: unknown) {
    super(`Headroom writer lock unavailable: ${String(cause)}`, { cause })
    this.name = "HeadroomWriterBusyError"
  }
}

export function acquireWriterLease(dataDir: string): { close(): void } {
  const db = new Database(path.join(dataDir, "writer-lock.db"), { create: true })
  try {
    // A short busy wait lets concurrent SQLite file initialization settle.
    // BEGIN EXCLUSIVE, held until close, remains the root writer mutex.
    db.exec("PRAGMA busy_timeout=100")
    db.exec("BEGIN EXCLUSIVE")
    db.exec("CREATE TABLE IF NOT EXISTS writer(owner INTEGER)")
    db.query("INSERT INTO writer VALUES (?)").run(process.pid)
    let closed = false
    return {
      close() {
        if (!closed) {
          closed = true
          db.exec("ROLLBACK")
          db.close()
        }
      },
    }
  } catch (error) {
    db.close()
    const code = (error as { code?: string })?.code
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") throw new HeadroomWriterBusyError(error)
    throw error
  }
}
