import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import {
  ProvisionalActionStore,
  type InsertProvisionalActionArgs,
} from './provisional-action.store';

const insertArgs = (
  overrides: Partial<InsertProvisionalActionArgs> = {},
): InsertProvisionalActionArgs => ({
  id: 'pa-1',
  type: 'BREAK_GLASS_APPROVAL',
  requestId: 'req-1',
  invokedBy: 'mgr-1',
  invokedAt: '2026-05-11T12:00:00.000Z',
  reason: 'outage – approving offline',
  outageStartObservedAt: '2026-05-11T11:30:00.000Z',
  localStateSnapshot: { balance: { available: '10', pendingHold: '3' } },
  ...overrides,
});

describe('ProvisionalActionStore', () => {
  let db: Database;
  let store: ProvisionalActionStore;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new ProvisionalActionStore(db);
  });

  afterEach(() => db.close());

  describe('insert + find round-trip', () => {
    it('persists every column and hydrates snapshot JSON', () => {
      store.insert(insertArgs());
      const row = store.find('pa-1');
      expect(row).toMatchObject({
        id: 'pa-1',
        type: 'BREAK_GLASS_APPROVAL',
        requestId: 'req-1',
        invokedBy: 'mgr-1',
        invokedAt: '2026-05-11T12:00:00.000Z',
        reason: 'outage – approving offline',
        outageStartObservedAt: '2026-05-11T11:30:00.000Z',
        reconciliationState: 'PENDING',
        reconciledAt: null,
        reconciliationDetails: null,
        localStateSnapshotSummary: null,
        lastStaleAlertAt: null,
      });
      expect(row?.localStateSnapshot).toEqual({
        balance: { available: '10', pendingHold: '3' },
      });
    });

    it('returns null for an unknown id', () => {
      expect(store.find('nope')).toBeNull();
    });
  });

  describe('findByRequestId', () => {
    it('returns every action for a request in invokedAt order', () => {
      store.insert(insertArgs({ id: 'pa-late', invokedAt: '2026-05-11T13:00:00.000Z' }));
      store.insert(insertArgs({ id: 'pa-early', invokedAt: '2026-05-11T11:00:00.000Z' }));
      expect(store.findByRequestId('req-1').map((r) => r.id)).toEqual(['pa-early', 'pa-late']);
    });

    it('returns an empty array for an unknown request', () => {
      expect(store.findByRequestId('nope')).toEqual([]);
    });
  });

  describe('listPending', () => {
    it('returns only rows still in PENDING, ordered by invokedAt', () => {
      store.insert(insertArgs({ id: 'pa-1', invokedAt: '2026-05-11T11:00:00.000Z' }));
      store.insert(insertArgs({ id: 'pa-2', invokedAt: '2026-05-11T12:00:00.000Z' }));
      store.insert(insertArgs({ id: 'pa-3', invokedAt: '2026-05-11T13:00:00.000Z' }));
      store.markReconciled({
        id: 'pa-2',
        reconciliationState: 'CONFIRMED',
        reconciledAt: '2026-05-11T14:00:00.000Z',
        reconciliationDetails: { matched: true },
        snapshotSummary: { available: '7' },
        nullifySnapshot: true,
      });
      expect(store.listPending().map((r) => r.id)).toEqual(['pa-1', 'pa-3']);
    });
  });

  describe('query — ProvisionalActionFilter', () => {
    beforeEach(() => {
      store.insert(insertArgs({ id: 'pa-A', requestId: 'req-A', invokedBy: 'mgr-1' }));
      store.insert(insertArgs({ id: 'pa-B', requestId: 'req-A', invokedBy: 'mgr-2' }));
      store.insert(insertArgs({ id: 'pa-C', requestId: 'req-B', invokedBy: 'mgr-1' }));
    });

    it('empty filter returns every row in invokedAt order', () => {
      expect(store.query({}).map((r) => r.id).sort()).toEqual(['pa-A', 'pa-B', 'pa-C']);
    });

    it('filters by requestId', () => {
      expect(store.query({ requestId: 'req-A' }).map((r) => r.id).sort()).toEqual(['pa-A', 'pa-B']);
    });

    it('filters by invokedBy', () => {
      expect(store.query({ invokedBy: 'mgr-1' }).map((r) => r.id).sort()).toEqual(['pa-A', 'pa-C']);
    });

    it('ANDs multiple filters together', () => {
      expect(
        store.query({ requestId: 'req-A', invokedBy: 'mgr-2' }).map((r) => r.id),
      ).toEqual(['pa-B']);
    });

    it('filters by reconciliationState', () => {
      store.markReconciled({
        id: 'pa-A',
        reconciliationState: 'CONFIRMED',
        reconciledAt: '2026-05-11T14:00:00.000Z',
        reconciliationDetails: {},
        snapshotSummary: {},
        nullifySnapshot: true,
      });
      expect(store.query({ reconciliationState: 'CONFIRMED' }).map((r) => r.id)).toEqual(['pa-A']);
      expect(
        store.query({ reconciliationState: 'PENDING' }).map((r) => r.id).sort(),
      ).toEqual(['pa-B', 'pa-C']);
    });
  });

  describe('markReconciled — five-field allow-list (ADR-022)', () => {
    beforeEach(() => store.insert(insertArgs()));

    it('CONFIRMED nullifies snapshot, writes summary + details + reconciledAt', () => {
      store.markReconciled({
        id: 'pa-1',
        reconciliationState: 'CONFIRMED',
        reconciledAt: '2026-05-11T14:00:00.000Z',
        reconciliationDetails: { hcmTransactionId: 'tx-1' },
        snapshotSummary: { available: '7', units: '3' },
        nullifySnapshot: true,
      });
      const row = store.find('pa-1');
      expect(row?.reconciliationState).toBe('CONFIRMED');
      expect(row?.reconciledAt).toBe('2026-05-11T14:00:00.000Z');
      expect(row?.reconciliationDetails).toEqual({ hcmTransactionId: 'tx-1' });
      expect(row?.localStateSnapshotSummary).toEqual({ available: '7', units: '3' });
      expect(row?.localStateSnapshot).toBeNull();
    });

    it('REJECTED_ESCALATED retains the full snapshot for HR review', () => {
      store.markReconciled({
        id: 'pa-1',
        reconciliationState: 'REJECTED_ESCALATED',
        reconciledAt: '2026-05-11T14:00:00.000Z',
        reconciliationDetails: { hcmError: 'INSUFFICIENT_BALANCE' },
        snapshotSummary: { reason: 'HCM rejected on reconciliation' },
        nullifySnapshot: false,
      });
      const row = store.find('pa-1');
      expect(row?.reconciliationState).toBe('REJECTED_ESCALATED');
      expect(row?.localStateSnapshot).toEqual({
        balance: { available: '10', pendingHold: '3' },
      });
      expect(row?.localStateSnapshotSummary).toEqual({
        reason: 'HCM rejected on reconciliation',
      });
    });

    it('NO_OP nullifies snapshot like CONFIRMED', () => {
      store.markReconciled({
        id: 'pa-1',
        reconciliationState: 'NO_OP',
        reconciledAt: '2026-05-11T14:00:00.000Z',
        reconciliationDetails: { reason: 'already reflected in HCM' },
        snapshotSummary: { already: true },
        nullifySnapshot: true,
      });
      expect(store.find('pa-1')?.localStateSnapshot).toBeNull();
    });

    it('leaves untouched columns alone (invokedAt, reason, outageStartObservedAt)', () => {
      store.markReconciled({
        id: 'pa-1',
        reconciliationState: 'CONFIRMED',
        reconciledAt: '2026-05-11T14:00:00.000Z',
        reconciliationDetails: {},
        snapshotSummary: {},
        nullifySnapshot: true,
      });
      const row = store.find('pa-1');
      expect(row?.invokedAt).toBe('2026-05-11T12:00:00.000Z');
      expect(row?.reason).toBe('outage – approving offline');
      expect(row?.outageStartObservedAt).toBe('2026-05-11T11:30:00.000Z');
    });
  });

  describe('recordStaleAlert', () => {
    it('updates only lastStaleAlertAt — used for dedup (TRD §9.5.6)', () => {
      store.insert(insertArgs());
      store.recordStaleAlert('pa-1', '2026-05-11T15:00:00.000Z');
      const row = store.find('pa-1');
      expect(row?.lastStaleAlertAt).toBe('2026-05-11T15:00:00.000Z');
      expect(row?.reconciliationState).toBe('PENDING');
    });
  });
});
