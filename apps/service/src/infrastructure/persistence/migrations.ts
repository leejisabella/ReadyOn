import type { Database } from 'better-sqlite3';

/**
 * Service schema migrations.
 *
 * The version-1 migration creates every table in TRD §5, every CHECK
 * constraint enforcing the state-machine enums from §6, and every index the
 * domain modules will rely on. Append-only triggers for `provisional_action`
 * and `reconciliation_step` live in {@link applyAppendOnlyTriggers} — they
 * are optional and gated by a runtime flag (ADR-019).
 *
 * @ref docs/01_TRD.md §5 (domain model)
 * @ref docs/01_TRD.md §6 (state vocabulary)
 * @ref docs/02_Assumptions_and_Decisions.md ADR-019, ADR-022, ADR-023
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
      -- ── Bookkeeping ──────────────────────────────────────────────────────

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- ── Employee bootstrap (§5.5) ────────────────────────────────────────

      CREATE TABLE employee (
        employee_id           TEXT PRIMARY KEY,
        bootstrapped_at       TEXT NOT NULL,
        bootstrap_source      TEXT NOT NULL
          CHECK (bootstrap_source IN ('WEBHOOK','LAZY_PULL','BATCH')),
        hcm_version           TEXT NOT NULL,
        last_seen_in_batch_at TEXT
      );

      -- ── Employment timeline (§5.3) ───────────────────────────────────────

      CREATE TABLE employment (
        employee_id    TEXT NOT NULL,
        location_id    TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to   TEXT,
        hcm_version    TEXT NOT NULL,
        PRIMARY KEY (employee_id, effective_from)
      );
      CREATE INDEX idx_employment_employee ON employment(employee_id);

      -- ── Leave-type availability (§5.4) ───────────────────────────────────

      CREATE TABLE leave_type_availability (
        location_id    TEXT NOT NULL,
        leave_type_id  TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to   TEXT,
        is_active      INTEGER NOT NULL DEFAULT 1,
        hcm_version    TEXT NOT NULL,
        PRIMARY KEY (location_id, leave_type_id, effective_from)
      );
      CREATE INDEX idx_lta_location ON leave_type_availability(location_id);

      -- ── Balance projection with three hold buckets (§5.1) ────────────────

      CREATE TABLE balance (
        employee_id        TEXT NOT NULL,
        location_id        TEXT NOT NULL,
        leave_type_id      TEXT NOT NULL,
        available          TEXT NOT NULL,
        pending_hold       TEXT NOT NULL DEFAULT '0',
        approved_hold      TEXT NOT NULL DEFAULT '0',
        provisional_hold   TEXT NOT NULL DEFAULT '0',
        hcm_version        TEXT NOT NULL,
        hcm_effective_at   TEXT NOT NULL,
        local_updated_at   TEXT NOT NULL,
        last_reconciled_at TEXT NOT NULL,
        state              TEXT NOT NULL
          CHECK (state IN ('SYNCED','RECONCILING','UNDER_HOLD_DEFICIT','STALE')),
        PRIMARY KEY (employee_id, location_id, leave_type_id)
      );

      -- ── Time-off request (§5.2) ──────────────────────────────────────────

      CREATE TABLE time_off_request (
        id                        TEXT PRIMARY KEY,
        idempotency_key           TEXT NOT NULL UNIQUE,
        input_hash                TEXT NOT NULL,
        employee_id               TEXT NOT NULL,
        location_id               TEXT NOT NULL,
        leave_type_id             TEXT NOT NULL,
        start_date                TEXT NOT NULL,
        end_date                  TEXT NOT NULL,
        units                     TEXT NOT NULL,
        state                     TEXT NOT NULL CHECK (state IN (
          'DRAFT',
          'PENDING_APPROVAL',
          'AWAITING_HCM_COMMIT',
          'PROVISIONALLY_APPROVED',
          'APPROVED',
          'REJECTED',
          'CANCELLATION_PENDING',
          'CANCELLED',
          'TAKEN',
          'NEEDS_REVALIDATION',
          'ESCALATED_TO_HR'
        )),
        hcm_transaction_id        TEXT,
        provisional_approval_id   TEXT,
        approved_by               TEXT,
        approved_at               TEXT,
        rejected_reason           TEXT,
        rejected_at               TEXT,
        cancelled_at              TEXT,
        escalated_at              TEXT,
        escalation_reason         TEXT,
        hr_review_flag            INTEGER NOT NULL DEFAULT 0,
        hr_review_reason          TEXT,
        needs_revalidation_reason TEXT,
        created_at                TEXT NOT NULL,
        updated_at                TEXT NOT NULL
      );
      CREATE INDEX idx_request_employee_state ON time_off_request(employee_id, state);
      CREATE INDEX idx_request_provisional_approval
        ON time_off_request(provisional_approval_id)
        WHERE provisional_approval_id IS NOT NULL;
      CREATE INDEX idx_request_hr_review
        ON time_off_request(state, hr_review_flag)
        WHERE state = 'TAKEN' AND hr_review_flag = 1;

      -- ── Provisional action event log (§5.6, Rev 3.1 retention §5.6.1) ───

      CREATE TABLE provisional_action (
        id                           TEXT PRIMARY KEY,
        type                         TEXT NOT NULL
          CHECK (type IN ('BREAK_GLASS_APPROVAL','PROVISIONAL_CANCELLATION')),
        request_id                   TEXT NOT NULL,
        invoked_by                   TEXT NOT NULL,
        invoked_at                   TEXT NOT NULL,
        reason                       TEXT NOT NULL,
        outage_start_observed_at     TEXT NOT NULL,
        local_state_snapshot         TEXT,
        local_state_snapshot_summary TEXT,
        reconciliation_state         TEXT NOT NULL CHECK (reconciliation_state IN (
          'PENDING','CONFIRMED','REJECTED_ESCALATED','NO_OP'
        )),
        reconciled_at                TEXT,
        reconciliation_details       TEXT,
        last_stale_alert_at          TEXT
      );
      CREATE INDEX idx_provisional_action_state
        ON provisional_action(reconciliation_state)
        WHERE reconciliation_state = 'PENDING';
      CREATE INDEX idx_provisional_action_request ON provisional_action(request_id);
      CREATE INDEX idx_provisional_action_invoked_at ON provisional_action(invoked_at);

      -- ── Reconciliation step log (§5.7, Rev 3 Q.γ) ────────────────────────

      CREATE TABLE reconciliation_step (
        id            TEXT PRIMARY KEY,
        action_id     TEXT NOT NULL,
        step_sequence INTEGER NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN (
          'HCM_HISTORY_QUERIED',
          'HCM_HISTORY_QUERY_FAILED',
          'HISTORY_MISMATCH',
          'HCM_CALL_IN_FLIGHT',
          'OUTCOME_APPLIED',
          'OUTCOME_INVALID',
          'PAIR_COALESCED',
          'EMPLOYEE_NOT_FOUND_AT_HCM',
          'TERMINAL'
        )),
        outcome       TEXT NOT NULL CHECK (outcome IN ('PARTIAL','TERMINAL')),
        payload       TEXT NOT NULL,
        occurred_at   TEXT NOT NULL,
        worker_id     TEXT NOT NULL
      );
      CREATE INDEX idx_recon_step_action ON reconciliation_step(action_id, step_sequence);

      -- ── Reconciler advisory lease (§5.9, Rev 3.1 Q.ι) ────────────────────

      CREATE TABLE reconciler_lease (
        id          TEXT PRIMARY KEY,
        held_by     TEXT,
        acquired_at TEXT,
        expires_at  TEXT
      );
      INSERT INTO reconciler_lease (id, held_by, acquired_at, expires_at)
                            VALUES ('provisional', NULL, NULL, NULL);

      -- ── Outbox (§5.7) ────────────────────────────────────────────────────

      CREATE TABLE outbox_entry (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL CHECK (type IN (
          'RESERVE_BALANCE',
          'RELEASE_BALANCE',
          'FETCH_BALANCE',
          'BOOTSTRAP_EMPLOYEE',
          'RECONCILE_PROVISIONAL'
        )),
        payload         TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN (
          'PENDING','IN_FLIGHT','SUCCEEDED','SUSPECT_NO_OP','FAILED_RETRYABLE','FAILED_PERMANENT'
        )),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error      TEXT,
        idempotency_key TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_outbox_state_attempt ON outbox_entry(state, next_attempt_at);
      CREATE INDEX idx_outbox_idem ON outbox_entry(idempotency_key);

      -- ── Inbox (§5.7) ─────────────────────────────────────────────────────

      CREATE TABLE inbox_event (
        id               TEXT PRIMARY KEY,
        source           TEXT NOT NULL CHECK (source IN ('WEBHOOK','BATCH')),
        type             TEXT NOT NULL CHECK (type IN (
          'BALANCE_UPDATED','EMPLOYMENT_CHANGED','LEAVE_TYPE_CHANGED','EMPLOYEE_CREATED'
        )),
        payload          TEXT NOT NULL,
        hcm_version      TEXT NOT NULL,
        received_at      TEXT NOT NULL,
        processed_at     TEXT,
        processing_error TEXT
      );
      CREATE INDEX idx_inbox_unprocessed ON inbox_event(processed_at) WHERE processed_at IS NULL;

      -- ── Idempotency-key cache (§5.7, §14.1) ──────────────────────────────

      CREATE TABLE idempotency_key (
        key               TEXT PRIMARY KEY,
        input_hash        TEXT NOT NULL,
        response_snapshot TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        expires_at        TEXT NOT NULL
      );
      CREATE INDEX idx_idempotency_expires ON idempotency_key(expires_at);

      -- ── Audit log (§5.7) ─────────────────────────────────────────────────

      CREATE TABLE audit_event (
        id             TEXT PRIMARY KEY,
        entity_type    TEXT NOT NULL,
        entity_id      TEXT NOT NULL,
        actor          TEXT NOT NULL,
        action         TEXT NOT NULL,
        severity       TEXT NOT NULL DEFAULT 'INFO'
          CHECK (severity IN ('INFO','LOW','MEDIUM','HIGH')),
        before_json    TEXT,
        after_json     TEXT,
        correlation_id TEXT NOT NULL,
        occurred_at    TEXT NOT NULL
      );
      CREATE INDEX idx_audit_entity ON audit_event(entity_type, entity_id, occurred_at);
      CREATE INDEX idx_audit_correlation ON audit_event(correlation_id);
    `,
  },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as ReadonlyArray<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
  }
}

/**
 * Drop every domain table and rerun migrations. Used by tests for clean-room
 * isolation between specs that share a DB handle.
 */
export function resetSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS audit_event;
    DROP TABLE IF EXISTS idempotency_key;
    DROP TABLE IF EXISTS inbox_event;
    DROP TABLE IF EXISTS outbox_entry;
    DROP TABLE IF EXISTS reconciler_lease;
    DROP TABLE IF EXISTS reconciliation_step;
    DROP TABLE IF EXISTS provisional_action;
    DROP TABLE IF EXISTS time_off_request;
    DROP TABLE IF EXISTS balance;
    DROP TABLE IF EXISTS leave_type_availability;
    DROP TABLE IF EXISTS employment;
    DROP TABLE IF EXISTS employee;
    DROP TABLE IF EXISTS meta;
    DROP TABLE IF EXISTS schema_migrations;
  `);
  runMigrations(db);
}
