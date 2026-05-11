import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { BalanceService } from '../../domain/balance/balance.service';
import { BalanceStore, type BalanceState } from '../../domain/balance/balance.store';
import { OutboxStore } from '../outbox/outbox.store';
import { DriftSweep } from './drift-sweep.service';
import { PointReadScheduler } from './point-read-scheduler.service';

/**
 * Tests insert balance rows directly via SQL so the `last_reconciled_at` we
 * exercise is fully controlled — sidesteps the real-clock vs fake-clock
 * mismatch that would otherwise leak through `BalanceService.applyHcmUpdate`.
 */
function insertBalance(
  db: Database,
  args: {
    readonly employeeId: string;
    readonly locationId?: string;
    readonly leaveTypeId?: string;
    readonly lastReconciledAt: string;
    readonly state?: BalanceState;
  },
): void {
  db.prepare(
    `INSERT INTO balance
        (employee_id, location_id, leave_type_id, available,
         pending_hold, approved_hold, provisional_hold,
         hcm_version, hcm_effective_at, local_updated_at, last_reconciled_at, state)
      VALUES (?, ?, ?, '10', '0', '0', '0', '1', ?, ?, ?, ?)`,
  ).run(
    args.employeeId,
    args.locationId ?? 'loc-1',
    args.leaveTypeId ?? 'pto',
    args.lastReconciledAt,
    args.lastReconciledAt,
    args.lastReconciledAt,
    args.state ?? 'SYNCED',
  );
}

describe('DriftSweep', () => {
  let db: Database;
  let balance: BalanceService;
  let scheduler: PointReadScheduler;
  let sweep: DriftSweep;
  const NOW_MS = Date.UTC(2026, 5, 11, 12, 0, 0);

  beforeEach(() => {
    db = makeServiceTestDb();
    balance = new BalanceService(new BalanceStore(db), db);
    scheduler = new PointReadScheduler(new OutboxStore(db), {
      delayMs: 0,
      jitterMs: 0,
      maxPerTick: 100,
      now: () => NOW_MS,
      random: () => 0,
    });
    sweep = new DriftSweep(balance, scheduler, {
      staleAfterMs: 60_000,
      now: () => NOW_MS,
    });
  });

  afterEach(() => db.close());

  it('schedules point-reads for stale balances and skips fresh ones', () => {
    insertBalance(db, {
      employeeId: 'emp-stale-1',
      lastReconciledAt: new Date(NOW_MS - 120_000).toISOString(),
    });
    insertBalance(db, {
      employeeId: 'emp-stale-2',
      lastReconciledAt: new Date(NOW_MS - 120_000).toISOString(),
    });
    insertBalance(db, {
      employeeId: 'emp-fresh',
      lastReconciledAt: new Date(NOW_MS - 30_000).toISOString(),
    });

    const result = sweep.tick();
    expect(result.inspected).toBe(2);
    expect(result.scheduled).toBe(2);
    expect(scheduler.pendingCount()).toBe(2);
  });

  it('skips balances already in RECONCILING state', () => {
    insertBalance(db, {
      employeeId: 'emp-1',
      lastReconciledAt: new Date(NOW_MS - 120_000).toISOString(),
      state: 'RECONCILING',
    });

    const result = sweep.tick();
    expect(result.inspected).toBe(1);
    expect(result.scheduled).toBe(0);
    expect(result.skippedReconciling).toBe(1);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('returns zero counts when nothing is stale', () => {
    insertBalance(db, {
      employeeId: 'emp-fresh',
      lastReconciledAt: new Date(NOW_MS - 30_000).toISOString(),
    });
    const result = sweep.tick();
    expect(result).toEqual({ inspected: 0, scheduled: 0, skippedReconciling: 0 });
  });

  it('respects perTickLimit', () => {
    for (let i = 0; i < 5; i += 1) {
      insertBalance(db, {
        employeeId: `emp-${i}`,
        leaveTypeId: `type-${i}`,
        lastReconciledAt: new Date(NOW_MS - 120_000).toISOString(),
      });
    }
    sweep = new DriftSweep(balance, scheduler, {
      staleAfterMs: 60_000,
      perTickLimit: 2,
      now: () => NOW_MS,
    });
    const result = sweep.tick();
    expect(result.inspected).toBe(2);
    expect(result.scheduled).toBe(2);
  });
});
