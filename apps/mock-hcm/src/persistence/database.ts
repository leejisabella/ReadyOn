import BetterSqlite3, { type Database } from 'better-sqlite3';

/**
 * Construct the Mock HCM's private SQLite handle.
 *
 * The mock keeps a separate database from the service per ADR (TRD §17.4) so
 * crash-recovery tests can assert HCM-side state independently. WAL mode is
 * enabled where the storage supports it; `:memory:` databases silently ignore
 * the pragma.
 */
export function createMockHcmDatabase(dbPath: string): Database {
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

export type { Database };
