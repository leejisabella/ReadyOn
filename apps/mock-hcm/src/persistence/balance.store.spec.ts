import type { Database } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { makeTestDb } from '../../test/db-helper';
import { BalanceStore } from './balance.store';

const row = (overrides: Partial<Parameters<BalanceStore['upsert']>[0]> = {}) => ({
  employeeId: 'emp-1',
  locationId: 'loc-1',
  leaveTypeId: 'pto',
  available: new Decimal('10'),
  hcmVersion: 1n,
  appliedAt: '2026-05-11T00:00:00.000Z',
  ...overrides,
});

describe('BalanceStore', () => {
  let db: Database;
  let store: BalanceStore;

  beforeEach(() => {
    db = makeTestDb();
    store = new BalanceStore(db);
  });

  afterEach(() => db.close());

  it('returns null when the balance does not exist', () => {
    expect(store.find('emp-x', 'loc-x', 'pto')).toBeNull();
  });

  it('inserts a new balance and reads it back with hydrated types', () => {
    store.upsert(row());
    const found = store.find('emp-1', 'loc-1', 'pto');
    expect(found).not.toBeNull();
    expect(found!.available).toBeInstanceOf(Decimal);
    expect(found!.available.toFixed()).toBe('10');
    expect(found!.hcmVersion).toBe(1n);
  });

  it('upsert replaces an existing balance row', () => {
    store.upsert(row({ available: new Decimal('10'), hcmVersion: 1n }));
    store.upsert(row({ available: new Decimal('7.50'), hcmVersion: 2n }));
    const found = store.find('emp-1', 'loc-1', 'pto');
    expect(found!.available.toFixed()).toBe('7.5');
    expect(found!.hcmVersion).toBe(2n);
  });

  it('keeps dimensions distinct', () => {
    store.upsert(row({ locationId: 'loc-a', available: new Decimal('1') }));
    store.upsert(row({ locationId: 'loc-b', available: new Decimal('2') }));
    expect(store.find('emp-1', 'loc-a', 'pto')!.available.toFixed()).toBe('1');
    expect(store.find('emp-1', 'loc-b', 'pto')!.available.toFixed()).toBe('2');
  });

  it('listAll returns every row ordered by (employee, location, leaveType)', () => {
    store.upsert(row({ employeeId: 'emp-b' }));
    store.upsert(row({ employeeId: 'emp-a' }));
    const ids = store.listAll().map((r) => r.employeeId);
    expect(ids).toEqual(['emp-a', 'emp-b']);
  });

  it('preserves decimal precision across the round-trip', () => {
    store.upsert(row({ available: new Decimal('123.4567890123456789') }));
    expect(store.find('emp-1', 'loc-1', 'pto')!.available.toFixed()).toBe('123.4567890123456789');
  });
});
