import type { Database } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { makeTestDb } from '../../test/db-helper';
import {
  TransactionStore,
  type TransactionRecord,
} from './transaction.store';

const txn = (overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
  transactionId: `txn-${Math.random().toString(36).slice(2, 8)}`,
  idempotencyKey: null,
  employeeId: 'emp-1',
  locationId: 'loc-1',
  leaveTypeId: 'pto',
  deltaApplied: new Decimal('-2'),
  newAvailable: new Decimal('8'),
  hcmVersion: 1n,
  appliedAt: '2026-05-11T10:00:00.000Z',
  outcome: 'ACCEPTED',
  rejectionReason: null,
  statusCode: 200,
  responseBody: { ok: true },
  ...overrides,
});

describe('TransactionStore', () => {
  let db: Database;
  let store: TransactionStore;

  beforeEach(() => {
    db = makeTestDb();
    store = new TransactionStore(db);
  });

  afterEach(() => db.close());

  describe('insert + findByIdempotencyKey', () => {
    it('returns null when the key has not been seen', () => {
      expect(store.findByIdempotencyKey('never-used')).toBeNull();
    });

    it('returns the stored record (with hydrated types) on hit', () => {
      const record = txn({ idempotencyKey: 'idem-1', deltaApplied: new Decimal('-3.5') });
      store.insert(record);
      const found = store.findByIdempotencyKey('idem-1');
      expect(found).not.toBeNull();
      expect(found!.deltaApplied).toBeInstanceOf(Decimal);
      expect(found!.deltaApplied.toFixed()).toBe('-3.5');
      expect(found!.hcmVersion).toBe(1n);
    });

    it('round-trips the response body verbatim for replay', () => {
      const body = { transactionId: 'x', deltaApplied: '-2', newAvailable: '8', hcmVersion: '5', appliedAt: 'now' };
      store.insert(txn({ idempotencyKey: 'idem-replay', responseBody: body }));
      expect(store.findByIdempotencyKey('idem-replay')!.responseBody).toEqual(body);
    });

    it('rejects duplicate idempotency keys (unique partial index)', () => {
      store.insert(txn({ idempotencyKey: 'idem-dup' }));
      expect(() => store.insert(txn({ idempotencyKey: 'idem-dup' }))).toThrow();
    });

    it('allows multiple transactions with NULL idempotency key', () => {
      store.insert(txn({ idempotencyKey: null }));
      expect(() => store.insert(txn({ idempotencyKey: null }))).not.toThrow();
    });
  });

  describe('query (TRD §13.2.1)', () => {
    beforeEach(() => {
      store.insert(
        txn({
          transactionId: 'txn-1',
          idempotencyKey: 'action-a',
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveTypeId: 'pto',
          deltaApplied: new Decimal('-1'),
          appliedAt: '2026-05-11T08:00:00.000Z',
        }),
      );
      store.insert(
        txn({
          transactionId: 'txn-2',
          idempotencyKey: 'action-b',
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveTypeId: 'pto',
          deltaApplied: new Decimal('-2'),
          appliedAt: '2026-05-11T10:00:00.000Z',
        }),
      );
      store.insert(
        txn({
          transactionId: 'txn-3',
          idempotencyKey: 'action-c',
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveTypeId: 'pto',
          deltaApplied: new Decimal('-3'),
          appliedAt: '2026-05-11T12:00:00.000Z',
        }),
      );
      // Different dimension
      store.insert(
        txn({
          transactionId: 'txn-other',
          idempotencyKey: 'action-d',
          locationId: 'loc-DIFFERENT',
        }),
      );
      // Rejection (excluded from queryTransactions)
      store.insert(
        txn({
          transactionId: 'txn-reject',
          idempotencyKey: 'action-rejected',
          outcome: 'REJECTED',
          rejectionReason: 'INSUFFICIENT_BALANCE',
          statusCode: 400,
        }),
      );
    });

    it('filters by dimensions and returns ACCEPTED only', () => {
      const results = store.query({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto' });
      expect(results.map((r) => r.transactionId)).toEqual(['txn-1', 'txn-2', 'txn-3']);
    });

    it('returns empty when dimensions match nothing', () => {
      expect(
        store.query({ employeeId: 'emp-x', locationId: 'loc-1', leaveTypeId: 'pto' }),
      ).toEqual([]);
    });

    it('with idempotencyKey filter returns at most one record (or none)', () => {
      const hit = store.query({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        idempotencyKey: 'action-b',
      });
      expect(hit).toHaveLength(1);
      expect(hit[0]!.transactionId).toBe('txn-2');

      const miss = store.query({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        idempotencyKey: 'action-not-applied',
      });
      expect(miss).toEqual([]);
    });

    it('restricts to the window when provided (Q.κ — TRD §13.2.1)', () => {
      const inside = store.query({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        window: { start: '2026-05-11T09:00:00.000Z', end: '2026-05-11T11:00:00.000Z' },
      });
      expect(inside.map((r) => r.transactionId)).toEqual(['txn-2']);
    });

    it('NEVER returns rejected transactions (queryTransactions is for confirmed deltas)', () => {
      const results = store.query({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        idempotencyKey: 'action-rejected',
      });
      expect(results).toEqual([]);
    });

    it('returns results ordered by applied_at ascending', () => {
      const results = store.query({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto' });
      const timestamps = results.map((r) => r.appliedAt);
      expect(timestamps).toEqual([...timestamps].sort());
    });
  });
});
