import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { resetSchema, runMigrations } from './migrations';

const EXPECTED_TABLES = [
  'audit_event',
  'balance',
  'employee',
  'employment',
  'idempotency_key',
  'inbox_event',
  'leave_type_availability',
  'meta',
  'outbox_entry',
  'provisional_action',
  'reconciler_lease',
  'reconciliation_step',
  'schema_migrations',
  'time_off_request',
];

function listTables(db: Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as ReadonlyArray<{
      name: string;
    }>
  )
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'));
}

function listIndexes(db: Database, table: string): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?`).all(table) as ReadonlyArray<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe('Service schema migrations (TRD §5)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeServiceTestDb();
  });

  afterEach(() => db.close());

  describe('table coverage', () => {
    it('creates every TRD §5 table', () => {
      expect(listTables(db)).toEqual(EXPECTED_TABLES);
    });

    it('records migration v1 in schema_migrations', () => {
      const rows = db.prepare('SELECT version, name FROM schema_migrations').all() as Array<{
        version: number;
        name: string;
      }>;
      expect(rows).toEqual([{ version: 1, name: 'initial_schema' }]);
    });
  });

  describe('reconciler_lease bootstrap (§5.9)', () => {
    it('seeds the single "provisional" row in an unheld state', () => {
      const row = db.prepare(`SELECT id, held_by, acquired_at, expires_at FROM reconciler_lease`).get() as {
        id: string;
        held_by: string | null;
        acquired_at: string | null;
        expires_at: string | null;
      };
      expect(row).toEqual({ id: 'provisional', held_by: null, acquired_at: null, expires_at: null });
    });
  });

  describe('CHECK constraints', () => {
    it.each([
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
      'ESCALATED_TO_HR',
    ])('accepts RequestState=%s', (state) => {
      expect(() => insertRequest(db, { state })).not.toThrow();
    });

    it('rejects an unknown RequestState value', () => {
      expect(() => insertRequest(db, { state: 'BANANA' })).toThrow(/CHECK constraint failed/);
    });

    it.each(['SYNCED', 'RECONCILING', 'UNDER_HOLD_DEFICIT', 'STALE'])(
      'accepts BalanceState=%s',
      (state) => {
        expect(() => insertBalance(db, { state })).not.toThrow();
      },
    );

    it('rejects an unknown BalanceState value', () => {
      expect(() => insertBalance(db, { state: 'WAT' })).toThrow(/CHECK constraint failed/);
    });

    it('rejects an unknown OutboxEntry state', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO outbox_entry
                (id,type,payload,state,next_attempt_at,idempotency_key,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?)`,
          )
          .run('o1', 'RESERVE_BALANCE', '{}', 'NOT_A_STATE', 't', 'k', 't', 't'),
      ).toThrow(/CHECK constraint failed/);
    });

    it.each([
      'HCM_HISTORY_QUERIED',
      'HCM_HISTORY_QUERY_FAILED',
      'HISTORY_MISMATCH',
      'HCM_CALL_IN_FLIGHT',
      'OUTCOME_APPLIED',
      'OUTCOME_INVALID',
      'PAIR_COALESCED',
      'EMPLOYEE_NOT_FOUND_AT_HCM',
      'TERMINAL',
    ])('accepts ReconciliationStep.kind=%s', (kind) => {
      expect(() => insertStep(db, { kind })).not.toThrow();
    });

    it('rejects an unknown ReconciliationStep.kind', () => {
      expect(() => insertStep(db, { kind: 'NOPE' })).toThrow(/CHECK constraint failed/);
    });
  });

  describe('indexes', () => {
    it('time_off_request has its expected indexes', () => {
      const names = listIndexes(db, 'time_off_request');
      expect(names).toEqual(
        expect.arrayContaining([
          'idx_request_employee_state',
          'idx_request_provisional_approval',
          'idx_request_hr_review',
        ]),
      );
    });

    it('provisional_action has its pending-state, request, and invoked_at indexes', () => {
      const names = listIndexes(db, 'provisional_action');
      expect(names).toEqual(
        expect.arrayContaining([
          'idx_provisional_action_state',
          'idx_provisional_action_request',
          'idx_provisional_action_invoked_at',
        ]),
      );
    });

    it('reconciliation_step indexes by (action_id, step_sequence) for resume queries', () => {
      expect(listIndexes(db, 'reconciliation_step')).toContain('idx_recon_step_action');
    });

    it('outbox_entry indexes for the claim query', () => {
      expect(listIndexes(db, 'outbox_entry')).toContain('idx_outbox_state_attempt');
    });
  });

  describe('idempotency', () => {
    it('running migrations twice is a no-op', () => {
      runMigrations(db);
      runMigrations(db);
      const versions = db.prepare('SELECT version FROM schema_migrations').all();
      expect(versions).toHaveLength(1);
    });
  });

  describe('resetSchema', () => {
    it('clears every table and re-applies migrations', () => {
      // pollute
      db.prepare('INSERT INTO employee (employee_id, bootstrapped_at, bootstrap_source, hcm_version) VALUES (?, ?, ?, ?)').run(
        'emp-1',
        'now',
        'WEBHOOK',
        '1',
      );
      resetSchema(db);
      const count = (
        db.prepare('SELECT COUNT(*) AS c FROM employee').get() as { c: number }
      ).c;
      expect(count).toBe(0);
      // schema fully present
      expect(listTables(db)).toEqual(EXPECTED_TABLES);
      // reconciler_lease re-seeded
      expect(
        (db.prepare('SELECT COUNT(*) AS c FROM reconciler_lease').get() as { c: number }).c,
      ).toBe(1);
    });
  });

  describe('time_off_request idempotency_key uniqueness', () => {
    it('rejects duplicate idempotency keys', () => {
      insertRequest(db, { id: 'r1', idempotencyKey: 'idem-1' });
      expect(() => insertRequest(db, { id: 'r2', idempotencyKey: 'idem-1' })).toThrow(/UNIQUE/);
    });
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function insertRequest(
  db: Database,
  overrides: Partial<{ id: string; idempotencyKey: string; state: string }> = {},
): void {
  const id = overrides.id ?? `r-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO time_off_request
        (id, idempotency_key, input_hash, employee_id, location_id, leave_type_id,
         start_date, end_date, units, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.idempotencyKey ?? `idem-${id}`,
    'hash',
    'emp-1',
    'loc-1',
    'pto',
    '2026-05-11',
    '2026-05-12',
    '1',
    overrides.state ?? 'PENDING_APPROVAL',
    'now',
    'now',
  );
}

function insertBalance(db: Database, overrides: Partial<{ state: string }>): void {
  db.prepare(
    `INSERT INTO balance
        (employee_id, location_id, leave_type_id, available, hcm_version,
         hcm_effective_at, local_updated_at, last_reconciled_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `emp-${Math.random().toString(36).slice(2, 6)}`,
    'loc-1',
    'pto',
    '10',
    '1',
    'now',
    'now',
    'now',
    overrides.state ?? 'SYNCED',
  );
}

function insertStep(db: Database, overrides: Partial<{ kind: string }>): void {
  db.prepare(
    `INSERT INTO reconciliation_step
        (id, action_id, step_sequence, kind, outcome, payload, occurred_at, worker_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `s-${Math.random().toString(36).slice(2, 8)}`,
    'act-1',
    1,
    overrides.kind ?? 'HCM_HISTORY_QUERIED',
    'PARTIAL',
    '{}',
    'now',
    'worker-1',
  );
}
