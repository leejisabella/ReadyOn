import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import {
  AuditEventStore,
  type AppendAuditEventArgs,
} from './audit-event.store';

const baseArgs = (overrides: Partial<AppendAuditEventArgs> = {}): AppendAuditEventArgs => ({
  id: 'aud-1',
  entityType: 'TimeOffRequest',
  entityId: 'req-1',
  actor: 'mgr-1',
  action: 'REQUEST_APPROVED',
  severity: 'INFO',
  before: { state: 'PENDING_APPROVAL' },
  after: { state: 'APPROVED' },
  correlationId: 'corr-1',
  occurredAt: '2026-05-11T12:00:00.000Z',
  ...overrides,
});

describe('AuditEventStore', () => {
  let db: Database;
  let store: AuditEventStore;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new AuditEventStore(db);
  });
  afterEach(() => db.close());

  it('persists every column and hydrates before/after JSON', () => {
    store.append(baseArgs());
    const rows = store.findByEntity('TimeOffRequest', 'req-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'aud-1',
      entityType: 'TimeOffRequest',
      entityId: 'req-1',
      actor: 'mgr-1',
      action: 'REQUEST_APPROVED',
      severity: 'INFO',
      correlationId: 'corr-1',
      occurredAt: '2026-05-11T12:00:00.000Z',
    });
    expect(rows[0]?.before).toEqual({ state: 'PENDING_APPROVAL' });
    expect(rows[0]?.after).toEqual({ state: 'APPROVED' });
  });

  it('handles null before/after — informational events without diffs', () => {
    store.append(baseArgs({ id: 'aud-2', before: null, after: null }));
    const row = store.findByEntity('TimeOffRequest', 'req-1')[0];
    expect(row?.before).toBeNull();
    expect(row?.after).toBeNull();
  });

  it('findByEntity returns rows in occurredAt ascending order', () => {
    store.append(baseArgs({ id: 'a-late', occurredAt: '2026-05-11T13:00:00.000Z' }));
    store.append(baseArgs({ id: 'a-early', occurredAt: '2026-05-11T11:00:00.000Z' }));
    store.append(baseArgs({ id: 'a-mid', occurredAt: '2026-05-11T12:00:00.000Z' }));
    expect(store.findByEntity('TimeOffRequest', 'req-1').map((r) => r.id)).toEqual([
      'a-early',
      'a-mid',
      'a-late',
    ]);
  });

  it('findByCorrelation scopes the audit chain for one saga invocation', () => {
    store.append(baseArgs({ id: 'a-1', correlationId: 'corr-A' }));
    store.append(baseArgs({ id: 'a-2', correlationId: 'corr-B' }));
    store.append(baseArgs({ id: 'a-3', correlationId: 'corr-A' }));
    expect(store.findByCorrelation('corr-A').map((r) => r.id).sort()).toEqual(['a-1', 'a-3']);
  });

  it('rejects severities outside the CHECK constraint', () => {
    expect(() =>
      store.append(baseArgs({ severity: 'FATAL' as never })),
    ).toThrow(/CHECK constraint failed/);
  });
});
