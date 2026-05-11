import BetterSqlite3, { type Database } from 'better-sqlite3';

/**
 * Construct the service's SQLite handle.
 *
 * WAL mode permits a single writer with concurrent readers — fits our
 * single-process polling-outbox topology (TRD §8.1). `:memory:` ignores the
 * WAL pragma silently.
 */
export function createServiceDatabase(dbPath: string): Database {
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

export type { Database };
