import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import {
  LeaveTypeAvailabilityStore,
  type LeaveTypeAvailabilityPeriod,
} from './leave-type-availability.store';

const period = (
  overrides: Partial<LeaveTypeAvailabilityPeriod> = {},
): LeaveTypeAvailabilityPeriod => ({
  locationId: 'loc-1',
  leaveTypeId: 'pto',
  effectiveFrom: '2025-01-01',
  effectiveTo: null,
  isActive: true,
  hcmVersion: 1n,
  ...overrides,
});

describe('LeaveTypeAvailabilityStore', () => {
  let db: Database;
  let store: LeaveTypeAvailabilityStore;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new LeaveTypeAvailabilityStore(db);
  });

  afterEach(() => db.close());

  describe('find', () => {
    it('returns null when no row exists', () => {
      expect(store.find('loc-1', 'pto', '2025-01-01')).toBeNull();
    });

    it('hydrates isActive (TINYINT → boolean) and hcmVersion (TEXT → bigint)', () => {
      store.applyIfNewer(period({ isActive: false, hcmVersion: 99n }));
      const found = store.find('loc-1', 'pto', '2025-01-01');
      expect(found?.isActive).toBe(false);
      expect(found?.hcmVersion).toBe(99n);
    });
  });

  describe('findActiveAt — interval boundaries', () => {
    beforeEach(() => {
      store.applyIfNewer(period({ effectiveTo: '2025-05-31' })); // active in Q1–Q2
      store.applyIfNewer(period({ effectiveFrom: '2025-06-01', isActive: false, hcmVersion: 2n })); // deactivated
    });

    it.each([
      ['before any period', '2024-12-31', null],
      ['inside the active period', '2025-03-15', true],
      ['exactly on effectiveTo of active period (inclusive)', '2025-05-31', true],
      ['exactly on effectiveFrom of deactivated period (inclusive)', '2025-06-01', false],
      ['inside the deactivated period', '2026-01-01', false],
    ] as ReadonlyArray<readonly [string, string, boolean | null]>)(
      '%s → isActive=%s',
      (_label, asOfDate, expected) => {
        const found = store.findActiveAt('loc-1', 'pto', asOfDate);
        expect(found?.isActive ?? null).toBe(expected);
      },
    );
  });

  describe('listForLocation', () => {
    it('returns rows grouped by leaveTypeId then effectiveFrom', () => {
      store.applyIfNewer(period({ leaveTypeId: 'sick', hcmVersion: 1n }));
      store.applyIfNewer(period({ leaveTypeId: 'pto', hcmVersion: 1n }));
      store.applyIfNewer(period({ leaveTypeId: 'pto', effectiveFrom: '2025-06-01', hcmVersion: 2n }));
      const rows = store.listForLocation('loc-1');
      expect(rows.map((r) => `${r.leaveTypeId}/${r.effectiveFrom}`)).toEqual([
        'pto/2025-01-01',
        'pto/2025-06-01',
        'sick/2025-01-01',
      ]);
    });

    it('isolates results per location', () => {
      store.applyIfNewer(period({ locationId: 'loc-A' }));
      store.applyIfNewer(period({ locationId: 'loc-B' }));
      expect(store.listForLocation('loc-A')).toHaveLength(1);
      expect(store.listForLocation('loc-B')).toHaveLength(1);
    });
  });

  describe('applyIfNewer — hcmVersion ordering', () => {
    it('returns true on first insert', () => {
      expect(store.applyIfNewer(period({ hcmVersion: 5n }))).toBe(true);
    });

    it('applies a newer version, replacing isActive + effectiveTo', () => {
      store.applyIfNewer(period({ hcmVersion: 1n }));
      expect(
        store.applyIfNewer(period({ isActive: false, effectiveTo: '2025-12-31', hcmVersion: 2n })),
      ).toBe(true);
      const row = store.find('loc-1', 'pto', '2025-01-01');
      expect(row?.isActive).toBe(false);
      expect(row?.effectiveTo).toBe('2025-12-31');
    });

    it('skips an equal-version replay', () => {
      store.applyIfNewer(period({ hcmVersion: 1n }));
      expect(store.applyIfNewer(period({ isActive: false, hcmVersion: 1n }))).toBe(false);
      expect(store.find('loc-1', 'pto', '2025-01-01')?.isActive).toBe(true);
    });

    it('skips a stale event arriving out of order', () => {
      store.applyIfNewer(period({ hcmVersion: 10n }));
      expect(store.applyIfNewer(period({ isActive: false, hcmVersion: 5n }))).toBe(false);
      expect(store.find('loc-1', 'pto', '2025-01-01')?.isActive).toBe(true);
    });
  });
});
