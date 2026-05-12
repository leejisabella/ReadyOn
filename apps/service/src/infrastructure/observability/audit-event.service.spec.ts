import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { AuditEventService } from './audit-event.service';
import { AuditEventStore } from './audit-event.store';
import { CorrelationContext } from './correlation.context';

describe('AuditEventService', () => {
  let db: Database;
  let store: AuditEventStore;
  let correlation: CorrelationContext;
  let service: AuditEventService;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new AuditEventStore(db);
    correlation = new CorrelationContext();
    service = new AuditEventService(store, correlation);
  });
  afterEach(() => db.close());

  it('emits a row with the default severity for the action', () => {
    correlation.run('corr-1', () => {
      service.emit({
        action: 'REQUEST_APPROVED',
        entityType: 'TimeOffRequest',
        entityId: 'req-1',
        actor: 'mgr-1',
        after: { state: 'APPROVED' },
      });
    });
    const rows = store.findByEntity('TimeOffRequest', 'req-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'REQUEST_APPROVED',
      severity: 'INFO', // default for REQUEST_APPROVED
      correlationId: 'corr-1',
    });
  });

  it('uses the explicit severity override when provided (e.g. HR-flagged TAKEN)', () => {
    service.emit({
      action: 'REQUEST_CANCELLED',
      entityType: 'TimeOffRequest',
      entityId: 'req-x',
      actor: 'emp-x',
      severity: 'HIGH',
    });
    expect(store.findByEntity('TimeOffRequest', 'req-x')[0]?.severity).toBe('HIGH');
  });

  it('uses HIGH severity by default for escalation actions', () => {
    service.emit({
      action: 'PROVISIONAL_APPROVAL_ESCALATED',
      entityType: 'ProvisionalAction',
      entityId: 'pa-1',
      actor: 'reconciler',
    });
    expect(store.findByEntity('ProvisionalAction', 'pa-1')[0]?.severity).toBe('HIGH');
  });

  it('falls back to a fresh correlation id when none is bound', () => {
    service.emit({
      action: 'REQUEST_CREATED',
      entityType: 'TimeOffRequest',
      entityId: 'req-2',
      actor: 'emp-1',
    });
    const row = store.findByEntity('TimeOffRequest', 'req-2')[0]!;
    expect(row.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves correlationId across nested async-local scopes', async () => {
    await correlation.run('corr-outer', async () => {
      service.emit({
        action: 'REQUEST_CREATED',
        entityType: 'TimeOffRequest',
        entityId: 'req-a',
        actor: 'emp-1',
      });
      // a nested async fn that runs *inside* the same scope should see the same id
      await Promise.resolve().then(() => {
        service.emit({
          action: 'REQUEST_APPROVED',
          entityType: 'TimeOffRequest',
          entityId: 'req-a',
          actor: 'mgr-1',
        });
      });
    });
    const rows = store.findByCorrelation('corr-outer');
    expect(rows.map((r) => r.action).sort()).toEqual(['REQUEST_APPROVED', 'REQUEST_CREATED']);
  });
});
