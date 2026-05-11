import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { ReconcilerLeaseStore } from './reconciler-lease.store';

describe('ReconcilerLeaseStore', () => {
  let db: Database;
  let store: ReconcilerLeaseStore;
  const NOW = '2026-05-11T12:00:00.000Z';
  const EXPIRES = '2026-05-11T12:05:00.000Z';

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new ReconcilerLeaseStore(db);
  });

  afterEach(() => db.close());

  it('initializes with a single PENDING-ish row (held_by NULL)', () => {
    const row = store.find('provisional');
    expect(row).toEqual({
      id: 'provisional',
      heldBy: null,
      acquiredAt: null,
      expiresAt: null,
    });
  });

  it('acquires the lease when free', () => {
    expect(
      store.acquire({ id: 'provisional', holder: 'worker-1', at: NOW, expiresAt: EXPIRES }),
    ).toBe(true);
    expect(store.find('provisional')).toEqual({
      id: 'provisional',
      heldBy: 'worker-1',
      acquiredAt: NOW,
      expiresAt: EXPIRES,
    });
  });

  it('refuses a second concurrent acquire while the lease is live', () => {
    store.acquire({ id: 'provisional', holder: 'worker-1', at: NOW, expiresAt: EXPIRES });
    expect(
      store.acquire({
        id: 'provisional',
        holder: 'worker-2',
        at: '2026-05-11T12:01:00.000Z',
        expiresAt: '2026-05-11T12:06:00.000Z',
      }),
    ).toBe(false);
    expect(store.find('provisional')?.heldBy).toBe('worker-1');
  });

  it('reclaims an expired lease (worker crashed without releasing)', () => {
    store.acquire({ id: 'provisional', holder: 'crashed', at: NOW, expiresAt: EXPIRES });
    // a second acquire AT or AFTER expires_at wins
    expect(
      store.acquire({
        id: 'provisional',
        holder: 'worker-2',
        at: '2026-05-11T12:05:00.000Z',
        expiresAt: '2026-05-11T12:10:00.000Z',
      }),
    ).toBe(true);
    expect(store.find('provisional')?.heldBy).toBe('worker-2');
  });

  it('release succeeds only when called by the current holder', () => {
    store.acquire({ id: 'provisional', holder: 'worker-1', at: NOW, expiresAt: EXPIRES });
    expect(store.release('provisional', 'worker-2')).toBe(false);
    expect(store.find('provisional')?.heldBy).toBe('worker-1');
    expect(store.release('provisional', 'worker-1')).toBe(true);
    expect(store.find('provisional')?.heldBy).toBeNull();
  });
});
