import type { Database } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { makeServiceTestDb } from '../../../test/db-helper';
import {
  BalanceService,
  type BalanceSnapshot,
} from './balance.service';
import { BalanceStore } from './balance.store';
import { HoldDeltaError } from './hold-accountant';

const snapshot = (overrides: Partial<BalanceSnapshot> = {}): BalanceSnapshot => ({
  employeeId: 'emp-1',
  locationId: 'loc-1',
  leaveTypeId: 'pto',
  available: new Decimal('10'),
  hcmVersion: 1n,
  hcmEffectiveAt: '2026-05-11T00:00:00.000Z',
  ...overrides,
});

describe('BalanceService', () => {
  let db: Database;
  let service: BalanceService;

  beforeEach(() => {
    db = makeServiceTestDb();
    service = new BalanceService(new BalanceStore(db), db);
    // every test starts with one seeded balance row
    service.applyHcmUpdate(snapshot());
  });

  afterEach(() => db.close());

  // ── Reads ────────────────────────────────────────────────────────────────

  describe('get / listForEmployee', () => {
    it('returns the seeded row with hydrated types', () => {
      const row = service.get('emp-1', 'loc-1', 'pto');
      expect(row?.available).toBeInstanceOf(Decimal);
      expect(row?.available.toFixed()).toBe('10');
      expect(row?.holds.pending.toFixed()).toBe('0');
      expect(row?.holds.approved.toFixed()).toBe('0');
      expect(row?.holds.provisional.toFixed()).toBe('0');
      expect(row?.state).toBe('SYNCED');
      expect(typeof row?.hcmVersion).toBe('bigint');
    });

    it('returns null when the dimension is unknown', () => {
      expect(service.get('emp-x', 'loc-1', 'pto')).toBeNull();
    });

    it('listForEmployee returns every balance for an employee', () => {
      service.applyHcmUpdate(snapshot({ leaveTypeId: 'sick', hcmVersion: 2n }));
      expect(service.listForEmployee('emp-1')).toHaveLength(2);
    });
  });

  // ── Hold mutations ───────────────────────────────────────────────────────

  describe('applyHold', () => {
    it.each(['pending', 'approved', 'provisional'] as const)(
      'increments the %s bucket and stays SYNCED when within available',
      (kind) => {
        service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('3'), kind);
        const row = service.get('emp-1', 'loc-1', 'pto');
        expect(row?.holds[kind].toFixed()).toBe('3');
        expect(row?.state).toBe('SYNCED');
      },
    );

    it('does not touch other buckets', () => {
      service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('2'), 'pending');
      const row = service.get('emp-1', 'loc-1', 'pto');
      expect(row?.holds.approved.toFixed()).toBe('0');
      expect(row?.holds.provisional.toFixed()).toBe('0');
    });

    it('transitions to UNDER_HOLD_DEFICIT when total holds exceed available', () => {
      service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('11'), 'pending');
      expect(service.get('emp-1', 'loc-1', 'pto')?.state).toBe('UNDER_HOLD_DEFICIT');
    });

    it('throws HoldDeltaError on a negative-going delta', () => {
      expect(() =>
        service.releaseHold('emp-1', 'loc-1', 'pto', new Decimal('1'), 'pending'),
      ).toThrow(HoldDeltaError);
    });

    it('throws when the balance row is absent (caller must bootstrap first)', () => {
      expect(() =>
        service.applyHold('emp-x', 'loc-1', 'pto', new Decimal('1'), 'pending'),
      ).toThrow(/no balance exists/);
    });
  });

  describe('releaseHold', () => {
    it('decrements the bucket', () => {
      service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('5'), 'approved');
      service.releaseHold('emp-1', 'loc-1', 'pto', new Decimal('2'), 'approved');
      expect(service.get('emp-1', 'loc-1', 'pto')?.holds.approved.toFixed()).toBe('3');
    });

    it('restores SYNCED from UNDER_HOLD_DEFICIT when releasing back below available', () => {
      service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('11'), 'pending');
      expect(service.get('emp-1', 'loc-1', 'pto')?.state).toBe('UNDER_HOLD_DEFICIT');
      service.releaseHold('emp-1', 'loc-1', 'pto', new Decimal('11'), 'pending');
      expect(service.get('emp-1', 'loc-1', 'pto')?.state).toBe('SYNCED');
    });
  });

  describe('promoteHold', () => {
    it('atomically moves units between buckets', () => {
      service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('4'), 'pending');
      service.promoteHold('emp-1', 'loc-1', 'pto', new Decimal('3'), 'pending', 'approved');
      const row = service.get('emp-1', 'loc-1', 'pto');
      expect(row?.holds.pending.toFixed()).toBe('1');
      expect(row?.holds.approved.toFixed()).toBe('3');
    });

    it('throws and leaves the row untouched when the source bucket lacks units', () => {
      service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('1'), 'pending');
      expect(() =>
        service.promoteHold('emp-1', 'loc-1', 'pto', new Decimal('2'), 'pending', 'approved'),
      ).toThrow(HoldDeltaError);
      const row = service.get('emp-1', 'loc-1', 'pto');
      expect(row?.holds.pending.toFixed()).toBe('1');
      expect(row?.holds.approved.toFixed()).toBe('0');
    });
  });

  // ── applyHcmUpdate (TRD §6.1, §10.1) ─────────────────────────────────────

  describe('applyHcmUpdate', () => {
    it('inserts a brand-new row with zero holds and state SYNCED', () => {
      service.applyHcmUpdate(snapshot({ leaveTypeId: 'sick', available: new Decimal('5'), hcmVersion: 2n }));
      const row = service.get('emp-1', 'loc-1', 'sick');
      expect(row?.available.toFixed()).toBe('5');
      expect(row?.state).toBe('SYNCED');
    });

    it('updates available + hcmVersion when the incoming version is newer', () => {
      const applied = service.applyHcmUpdate(snapshot({ available: new Decimal('8'), hcmVersion: 2n }));
      expect(applied).toBe(true);
      const row = service.get('emp-1', 'loc-1', 'pto');
      expect(row?.available.toFixed()).toBe('8');
      expect(row?.hcmVersion).toBe(2n);
    });

    it('returns false and skips when version is equal (idempotent replay)', () => {
      expect(service.applyHcmUpdate(snapshot({ hcmVersion: 1n }))).toBe(false);
    });

    it('returns false and skips when version is older (stale event)', () => {
      service.applyHcmUpdate(snapshot({ available: new Decimal('20'), hcmVersion: 5n }));
      const applied = service.applyHcmUpdate(snapshot({ available: new Decimal('1'), hcmVersion: 3n }));
      expect(applied).toBe(false);
      expect(service.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('20');
    });

    it('transitions to UNDER_HOLD_DEFICIT when the new available is below current total holds', () => {
      service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('7'), 'approved');
      service.applyHcmUpdate(snapshot({ available: new Decimal('3'), hcmVersion: 2n }));
      expect(service.get('emp-1', 'loc-1', 'pto')?.state).toBe('UNDER_HOLD_DEFICIT');
    });

    it('restores SYNCED when the new available is no longer a deficit', () => {
      service.applyHold('emp-1', 'loc-1', 'pto', new Decimal('7'), 'approved');
      service.applyHcmUpdate(snapshot({ available: new Decimal('3'), hcmVersion: 2n }));
      service.applyHcmUpdate(snapshot({ available: new Decimal('100'), hcmVersion: 3n }));
      expect(service.get('emp-1', 'loc-1', 'pto')?.state).toBe('SYNCED');
    });
  });

  describe('preserves Decimal precision across the round-trip', () => {
    it('available holds 18 significant digits unchanged', () => {
      service.applyHcmUpdate(
        snapshot({ available: new Decimal('123.4567890123456789'), hcmVersion: 2n }),
      );
      expect(service.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe(
        '123.4567890123456789',
      );
    });
  });
});
