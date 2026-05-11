import type { Database } from 'better-sqlite3';
import { makeTestDb } from '../../test/db-helper';
import { VersionStore } from './version.store';

describe('VersionStore', () => {
  let db: Database;
  let store: VersionStore;

  beforeEach(() => {
    db = makeTestDb();
    store = new VersionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('starts at version 0', () => {
    expect(store.current()).toBe(0n);
  });

  it('next() returns 1, 2, 3, ... monotonically', () => {
    expect(store.next()).toBe(1n);
    expect(store.next()).toBe(2n);
    expect(store.next()).toBe(3n);
  });

  it('current() reflects the most recent next()', () => {
    store.next();
    store.next();
    expect(store.current()).toBe(2n);
  });
});
