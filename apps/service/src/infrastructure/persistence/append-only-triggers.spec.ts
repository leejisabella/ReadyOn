import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { PROVISIONAL_ACTION_ALLOWED_UPDATE_COLUMNS } from './append-only-triggers';

function seedProvisionalAction(db: Database, id: string = 'act-1'): void {
  db.prepare(
    `INSERT INTO provisional_action
        (id, type, request_id, invoked_by, invoked_at, reason,
         outage_start_observed_at, local_state_snapshot, reconciliation_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'BREAK_GLASS_APPROVAL',
    'req-1',
    'actor-1',
    '2026-05-11T10:00:00Z',
    'because',
    '2026-05-11T09:00:00Z',
    '{"snap":true}',
    'PENDING',
  );
}

function seedReconciliationStep(db: Database, id: string = 'step-1'): void {
  db.prepare(
    `INSERT INTO reconciliation_step
        (id, action_id, step_sequence, kind, outcome, payload, occurred_at, worker_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'act-1', 1, 'HCM_HISTORY_QUERIED', 'PARTIAL', '{}', '2026-05-11T10:00:00Z', 'worker-1');
}

describe('Append-only triggers (ADR-019, ADR-022)', () => {
  describe('when triggers are enabled', () => {
    let db: Database;
    beforeEach(() => {
      db = makeServiceTestDb({ appendOnlyTriggers: true });
    });
    afterEach(() => db.close());

    describe('provisional_action', () => {
      beforeEach(() => seedProvisionalAction(db));

      it('allows updates to every allow-listed column', () => {
        // reconciliation_state, reconciled_at, reconciliation_details
        expect(() =>
          db
            .prepare(
              `UPDATE provisional_action
                SET reconciliation_state = ?,
                    reconciled_at = ?,
                    reconciliation_details = ?
                WHERE id = ?`,
            )
            .run('CONFIRMED', '2026-05-11T11:00:00Z', '{"ok":true}', 'act-1'),
        ).not.toThrow();

        // local_state_snapshot, local_state_snapshot_summary, last_stale_alert_at
        expect(() =>
          db
            .prepare(
              `UPDATE provisional_action
                SET local_state_snapshot = NULL,
                    local_state_snapshot_summary = ?,
                    last_stale_alert_at = ?
                WHERE id = ?`,
            )
            .run('{"summary":1}', '2026-05-11T12:00:00Z', 'act-1'),
        ).not.toThrow();
      });

      it.each([
        ['type', `UPDATE provisional_action SET type='PROVISIONAL_CANCELLATION' WHERE id='act-1'`],
        ['request_id', `UPDATE provisional_action SET request_id='req-OTHER' WHERE id='act-1'`],
        ['invoked_by', `UPDATE provisional_action SET invoked_by='different' WHERE id='act-1'`],
        ['invoked_at', `UPDATE provisional_action SET invoked_at='2026-05-11T11:00:00Z' WHERE id='act-1'`],
        ['reason', `UPDATE provisional_action SET reason='changed' WHERE id='act-1'`],
        [
          'outage_start_observed_at',
          `UPDATE provisional_action SET outage_start_observed_at='2026-05-11T11:00:00Z' WHERE id='act-1'`,
        ],
      ])('blocks updates that touch the immutable column %s', (_col, sql) => {
        expect(() => db.exec(sql)).toThrow(/immutable field/);
      });

      it('blocks DELETE entirely', () => {
        expect(() => db.exec(`DELETE FROM provisional_action WHERE id='act-1'`)).toThrow(
          /delete prohibited/,
        );
      });
    });

    describe('reconciliation_step', () => {
      beforeEach(() => seedReconciliationStep(db));

      it('blocks any UPDATE', () => {
        expect(() =>
          db.exec(`UPDATE reconciliation_step SET kind='TERMINAL' WHERE id='step-1'`),
        ).toThrow(/updates prohibited/);
      });

      it('blocks any DELETE', () => {
        expect(() => db.exec(`DELETE FROM reconciliation_step WHERE id='step-1'`)).toThrow(
          /delete prohibited/,
        );
      });

      it('INSERTs remain unrestricted', () => {
        expect(() => seedReconciliationStep(db, 'step-2')).not.toThrow();
      });
    });
  });

  describe('when triggers are disabled (default)', () => {
    let db: Database;
    beforeEach(() => {
      db = makeServiceTestDb();
      seedProvisionalAction(db);
      seedReconciliationStep(db);
    });
    afterEach(() => db.close());

    it('updates to immutable fields are NOT blocked — repository layer is the only line of defense', () => {
      expect(() =>
        db.exec(`UPDATE provisional_action SET reason='off-allowlist' WHERE id='act-1'`),
      ).not.toThrow();
    });

    it('reconciliation_step accepts updates', () => {
      expect(() =>
        db.exec(`UPDATE reconciliation_step SET kind='TERMINAL' WHERE id='step-1'`),
      ).not.toThrow();
    });
  });

  describe('allow-list export (used by repository validation)', () => {
    it('contains the five ADR-022 fields plus last_stale_alert_at for §9.5.6', () => {
      expect([...PROVISIONAL_ACTION_ALLOWED_UPDATE_COLUMNS].sort()).toEqual([
        'last_stale_alert_at',
        'local_state_snapshot',
        'local_state_snapshot_summary',
        'reconciled_at',
        'reconciliation_details',
        'reconciliation_state',
      ]);
    });
  });
});
