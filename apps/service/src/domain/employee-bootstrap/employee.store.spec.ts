import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { EmployeeStore, type EmployeeRow } from './employee.store';

const row = (overrides: Partial<EmployeeRow> = {}): EmployeeRow => ({
  employeeId: 'emp-1',
  bootstrappedAt: '2026-05-11T10:00:00.000Z',
  bootstrapSource: 'WEBHOOK',
  hcmVersion: 1n,
  lastSeenInBatchAt: null,
  ...overrides,
});

describe('EmployeeStore', () => {
  let db: Database;
  let store: EmployeeStore;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new EmployeeStore(db);
  });

  afterEach(() => db.close());

  describe('find', () => {
    it('returns null when the row is absent', () => {
      expect(store.find('emp-x')).toBeNull();
    });

    it('hydrates hcmVersion as bigint and bootstrapSource as the literal union', () => {
      store.insertIfAbsent(row({ bootstrapSource: 'LAZY_PULL', hcmVersion: 42n }));
      const found = store.find('emp-1');
      expect(found?.hcmVersion).toBe(42n);
      expect(found?.bootstrapSource).toBe('LAZY_PULL');
    });
  });

  describe('insertIfAbsent (idempotency under race)', () => {
    it('returns true on first insert', () => {
      expect(store.insertIfAbsent(row())).toBe(true);
    });

    it('returns false when a row already exists; original row is preserved', () => {
      store.insertIfAbsent(row({ bootstrapSource: 'WEBHOOK', hcmVersion: 1n }));
      const applied = store.insertIfAbsent(
        row({ bootstrapSource: 'LAZY_PULL', hcmVersion: 99n }),
      );
      expect(applied).toBe(false);
      // First writer wins — race is safe even when sources differ.
      const found = store.find('emp-1');
      expect(found?.bootstrapSource).toBe('WEBHOOK');
      expect(found?.hcmVersion).toBe(1n);
    });
  });

  describe('recordSeenInBatch', () => {
    it('updates lastSeenInBatchAt without touching identity columns', () => {
      store.insertIfAbsent(row({ bootstrapSource: 'WEBHOOK' }));
      store.recordSeenInBatch('emp-1', '2026-06-01T03:00:00.000Z');
      const found = store.find('emp-1');
      expect(found?.lastSeenInBatchAt).toBe('2026-06-01T03:00:00.000Z');
      expect(found?.bootstrapSource).toBe('WEBHOOK');
      expect(found?.hcmVersion).toBe(1n);
    });

    it('is a no-op for an unknown employee', () => {
      expect(() => store.recordSeenInBatch('emp-x', '2026-06-01T03:00:00.000Z')).not.toThrow();
    });
  });
});
