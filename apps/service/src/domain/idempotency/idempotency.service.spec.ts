import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyStore } from './idempotency.store';

describe('IdempotencyService', () => {
  let db: Database;
  let service: IdempotencyService;

  beforeEach(() => {
    db = makeServiceTestDb();
    service = new IdempotencyService(new IdempotencyStore(db));
  });

  afterEach(() => db.close());

  it('returns `fresh` for an unknown key', () => {
    expect(service.resolve('key-x', 'hash-x')).toEqual({ kind: 'fresh' });
  });

  it('returns `replay` with the cached response for a matching key + hash', () => {
    service.remember('k1', 'h1', { requestId: 'req-1' });
    const resolution = service.resolve<{ requestId: string }>('k1', 'h1');
    expect(resolution).toEqual({ kind: 'replay', response: { requestId: 'req-1' } });
  });

  it('returns `conflict` when the same key was used with a different hash', () => {
    service.remember('k1', 'h1', { requestId: 'req-1' });
    expect(service.resolve('k1', 'h2')).toEqual({ kind: 'conflict' });
  });

  it('round-trips arbitrary JSON-shaped responses', () => {
    const payload = { a: 1, b: 'two', c: [3, 4, 5], d: { nested: true } };
    service.remember('k', 'h', payload);
    const resolution = service.resolve<typeof payload>('k', 'h');
    expect(resolution).toEqual({ kind: 'replay', response: payload });
  });

  it('stamps `expiresAt` at `createdAt + ttlMs` (TRD §14.1, §16: default 7 days)', () => {
    const before = Date.now();
    service.remember('k', 'h', { ok: true });
    const row = db.prepare('SELECT created_at, expires_at FROM idempotency_key WHERE key = ?').get('k') as
      | { created_at: string; expires_at: string }
      | undefined;
    expect(row).toBeDefined();
    const created = Date.parse(row!.created_at);
    const expires = Date.parse(row!.expires_at);
    expect(created).toBeGreaterThanOrEqual(before);
    // Default TTL is 7 days = 604_800_000 ms; the gap must match exactly.
    expect(expires - created).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('honours an explicit non-default ttlMs override', () => {
    service.remember('k', 'h', { ok: true }, 60_000);
    const row = db.prepare('SELECT created_at, expires_at FROM idempotency_key WHERE key = ?').get('k') as {
      created_at: string;
      expires_at: string;
    };
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(60_000);
  });
});
