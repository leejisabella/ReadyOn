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
});
