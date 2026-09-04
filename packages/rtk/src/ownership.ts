/** Durable session ownership for canonical rtk CAS objects. */
import { Database } from "bun:sqlite";

export interface OwnershipStore {
  grant(sessionId: string, hash: string): void;
  owns(sessionId: string, hash: string): boolean;
  close(): void;
}

export function openOwnershipStore(dataDir: string): OwnershipStore {
  const db = new Database(`${dataDir}/rtk-meta.db`, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rtk_refs (
      session_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, hash)
    )
  `);

  const grant = db.prepare(
    `INSERT OR IGNORE INTO rtk_refs(session_id, hash, created_at) VALUES (?, ?, ?)`,
  );
  const owns = db.prepare(
    `SELECT 1 AS present FROM rtk_refs WHERE session_id = ? AND hash = ?`,
  );

  return {
    grant(sessionId, hash): void {
      grant.run(sessionId, hash, Date.now());
    },
    owns(sessionId, hash): boolean {
      return owns.get(sessionId, hash) !== null;
    },
    close(): void {
      db.close();
    },
  };
}
