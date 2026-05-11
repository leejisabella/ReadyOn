import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { InboxStore, type IngestArgs } from './inbox.store';

const event = (overrides: Partial<IngestArgs> = {}): IngestArgs => ({
  id: 'evt-1',
  source: 'WEBHOOK',
  type: 'BALANCE_UPDATED',
  payload: { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', available: '10' },
  hcmVersion: 1n,
  receivedAt: '2026-05-11T00:00:00.000Z',
  ...overrides,
});

describe('InboxStore', () => {
  let db: Database;
  let store: InboxStore;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new InboxStore(db);
  });

  afterEach(() => db.close());

  it('inserts a new event and returns true', () => {
    expect(store.ingest(event())).toBe(true);
    expect(store.find('evt-1')?.type).toBe('BALANCE_UPDATED');
  });

  it('hydrates hcmVersion as bigint and payload as parsed JSON', () => {
    store.ingest(event({ hcmVersion: 42n, payload: { x: 1, y: 'two' } }));
    const found = store.find('evt-1');
    expect(found?.hcmVersion).toBe(42n);
    expect(found?.payload).toEqual({ x: 1, y: 'two' });
  });

  it('duplicate eventId is a silent no-op (dedupe)', () => {
    expect(store.ingest(event({ id: 'evt-dup' }))).toBe(true);
    expect(store.ingest(event({ id: 'evt-dup', payload: { x: 'different' } }))).toBe(false);
    // first writer wins
    expect((store.find('evt-dup')!.payload as { employeeId: string }).employeeId).toBe('emp-1');
  });

  it('claimUnprocessed orders by receivedAt and excludes already-processed rows', () => {
    store.ingest(event({ id: 'a', receivedAt: '2026-05-11T03:00:00Z' }));
    store.ingest(event({ id: 'b', receivedAt: '2026-05-11T01:00:00Z' }));
    store.ingest(event({ id: 'c', receivedAt: '2026-05-11T02:00:00Z' }));
    store.markProcessed('b', '2026-05-11T05:00:00Z');
    const claimed = store.claimUnprocessed(10);
    expect(claimed.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('markProcessed sets processedAt and clears any prior error', () => {
    store.ingest(event());
    store.markError('evt-1', 'something exploded');
    expect(store.find('evt-1')?.processingError).toBe('something exploded');
    store.markProcessed('evt-1', '2026-05-11T10:00:00Z');
    const after = store.find('evt-1');
    expect(after?.processedAt).toBe('2026-05-11T10:00:00Z');
    expect(after?.processingError).toBeNull();
  });
});
