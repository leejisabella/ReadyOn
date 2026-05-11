import type { Database } from 'better-sqlite3';

/**
 * Schema migrations for the Mock HCM. Versioned and idempotent — the runner
 * tracks applied versions in `schema_migrations` and skips anything already
 * present. Each migration runs in its own transaction.
 */

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('current_hcm_version', '0');

      CREATE TABLE employees (
        employee_id TEXT PRIMARY KEY,
        hcm_version TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE employment (
        employee_id    TEXT NOT NULL,
        location_id    TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to   TEXT,
        hcm_version    TEXT NOT NULL,
        PRIMARY KEY (employee_id, effective_from)
      );
      CREATE INDEX idx_employment_employee ON employment(employee_id);

      CREATE TABLE leave_types (
        location_id    TEXT    NOT NULL,
        leave_type_id  TEXT    NOT NULL,
        effective_from TEXT    NOT NULL,
        effective_to   TEXT,
        is_active      INTEGER NOT NULL DEFAULT 1,
        hcm_version    TEXT    NOT NULL,
        PRIMARY KEY (location_id, leave_type_id, effective_from)
      );
      CREATE INDEX idx_leave_types_location ON leave_types(location_id);

      CREATE TABLE balances (
        employee_id   TEXT NOT NULL,
        location_id   TEXT NOT NULL,
        leave_type_id TEXT NOT NULL,
        available     TEXT NOT NULL,
        hcm_version   TEXT NOT NULL,
        applied_at    TEXT NOT NULL,
        PRIMARY KEY (employee_id, location_id, leave_type_id)
      );

      CREATE TABLE transactions (
        transaction_id    TEXT    PRIMARY KEY,
        idempotency_key   TEXT,
        employee_id       TEXT    NOT NULL,
        location_id       TEXT    NOT NULL,
        leave_type_id     TEXT    NOT NULL,
        delta_applied     TEXT    NOT NULL,
        new_available     TEXT    NOT NULL,
        hcm_version       TEXT    NOT NULL,
        applied_at        TEXT    NOT NULL,
        outcome           TEXT    NOT NULL CHECK (outcome IN ('ACCEPTED', 'REJECTED')),
        rejection_reason  TEXT,
        status_code       INTEGER NOT NULL,
        response_body_json TEXT   NOT NULL
      );
      CREATE UNIQUE INDEX idx_transactions_idem
        ON transactions(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX idx_transactions_dimension
        ON transactions(employee_id, location_id, leave_type_id, applied_at);
    `,
  },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL
    )
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as ReadonlyArray<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    })();
  }
}

/**
 * Drop every domain table and rerun migrations. Used by the admin `/reset`
 * endpoint to give tests a clean slate without recreating the SQLite file.
 */
export function resetSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS transactions;
    DROP TABLE IF EXISTS balances;
    DROP TABLE IF EXISTS leave_types;
    DROP TABLE IF EXISTS employment;
    DROP TABLE IF EXISTS employees;
    DROP TABLE IF EXISTS meta;
    DROP TABLE IF EXISTS schema_migrations;
  `);
  runMigrations(db);
}
