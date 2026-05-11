import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { EmploymentStore, type EmploymentPeriod } from './employment.store';

const period = (overrides: Partial<EmploymentPeriod> = {}): EmploymentPeriod => ({
  employeeId: 'emp-1',
  locationId: 'loc-A',
  effectiveFrom: '2025-01-01',
  effectiveTo: null,
  hcmVersion: 1n,
  ...overrides,
});

describe('EmploymentStore', () => {
  let db: Database;
  let store: EmploymentStore;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new EmploymentStore(db);
  });

  afterEach(() => db.close());

  describe('find', () => {
    it('returns null when no row exists', () => {
      expect(store.find('emp-1', '2025-01-01')).toBeNull();
    });

    it('hydrates hcmVersion as bigint', () => {
      store.applyIfNewer(period({ hcmVersion: 42n }));
      const found = store.find('emp-1', '2025-01-01');
      expect(found?.hcmVersion).toBe(42n);
    });
  });

  describe('findActiveAt — interval boundaries', () => {
    beforeEach(() => {
      // Closed period: 2025-01-01 .. 2025-05-31 at loc-A
      store.applyIfNewer(period({ effectiveTo: '2025-05-31' }));
      // Open-ended period: 2025-06-01 .. forever at loc-B
      store.applyIfNewer(period({ locationId: 'loc-B', effectiveFrom: '2025-06-01', hcmVersion: 2n }));
    });

    it.each([
      ['before any period', '2024-12-31', null],
      ['exactly on effectiveFrom of first period', '2025-01-01', 'loc-A'],
      ['inside the closed period', '2025-03-15', 'loc-A'],
      ['exactly on effectiveTo of first period (inclusive)', '2025-05-31', 'loc-A'],
      ['exactly on effectiveFrom of next period (inclusive)', '2025-06-01', 'loc-B'],
      ['inside the open-ended period', '2030-01-01', 'loc-B'],
    ])('%s → %s', (_label, asOfDate, expected) => {
      const found = store.findActiveAt('emp-1', asOfDate);
      expect(found?.locationId ?? null).toBe(expected);
    });
  });

  describe('findActiveAt — gap between periods', () => {
    it('returns null inside a gap', () => {
      store.applyIfNewer(period({ effectiveTo: '2025-05-31' }));
      store.applyIfNewer(
        period({ locationId: 'loc-C', effectiveFrom: '2025-08-01', hcmVersion: 2n }),
      );
      expect(store.findActiveAt('emp-1', '2025-07-01')).toBeNull();
      expect(store.findActiveAt('emp-1', '2025-08-01')?.locationId).toBe('loc-C');
    });
  });

  describe('listForEmployee', () => {
    it('returns periods ordered by effectiveFrom ascending', () => {
      store.applyIfNewer(period({ effectiveFrom: '2025-06-01', locationId: 'loc-B', hcmVersion: 2n }));
      store.applyIfNewer(period({ effectiveFrom: '2025-01-01', effectiveTo: '2025-05-31' }));
      const list = store.listForEmployee('emp-1');
      expect(list.map((p) => p.effectiveFrom)).toEqual(['2025-01-01', '2025-06-01']);
    });

    it('isolates results per employee', () => {
      store.applyIfNewer(period({ employeeId: 'emp-a' }));
      store.applyIfNewer(period({ employeeId: 'emp-b', locationId: 'loc-B' }));
      expect(store.listForEmployee('emp-a')).toHaveLength(1);
      expect(store.listForEmployee('emp-b')).toHaveLength(1);
      expect(store.listForEmployee('emp-a')[0]?.locationId).toBe('loc-A');
    });
  });

  describe('applyIfNewer — hcmVersion ordering (TRD §10.1)', () => {
    it('returns true on first insert', () => {
      expect(store.applyIfNewer(period({ hcmVersion: 5n }))).toBe(true);
    });

    it('returns true and applies when the incoming version is strictly greater', () => {
      store.applyIfNewer(period({ hcmVersion: 1n }));
      const applied = store.applyIfNewer(period({ locationId: 'loc-CHANGED', hcmVersion: 2n }));
      expect(applied).toBe(true);
      expect(store.find('emp-1', '2025-01-01')?.locationId).toBe('loc-CHANGED');
    });

    it('returns false and skips when versions are equal (replay)', () => {
      store.applyIfNewer(period({ hcmVersion: 1n }));
      const applied = store.applyIfNewer(period({ locationId: 'loc-CHANGED', hcmVersion: 1n }));
      expect(applied).toBe(false);
      expect(store.find('emp-1', '2025-01-01')?.locationId).toBe('loc-A');
    });

    it('returns false and skips when an older version arrives out of order', () => {
      store.applyIfNewer(period({ hcmVersion: 10n }));
      const applied = store.applyIfNewer(period({ locationId: 'loc-OLDER', hcmVersion: 5n }));
      expect(applied).toBe(false);
      expect(store.find('emp-1', '2025-01-01')?.locationId).toBe('loc-A');
    });

    it('handles large bigint versions correctly (no string-comparison foot-gun)', () => {
      // String-compare would treat '9' > '10'; the CAST-to-INTEGER prevents it.
      store.applyIfNewer(period({ hcmVersion: 9n }));
      const applied = store.applyIfNewer(period({ locationId: 'loc-VERSION-10', hcmVersion: 10n }));
      expect(applied).toBe(true);
      expect(store.find('emp-1', '2025-01-01')?.locationId).toBe('loc-VERSION-10');
    });
  });
});
