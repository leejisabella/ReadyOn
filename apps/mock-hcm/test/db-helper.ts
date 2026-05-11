import { createMockHcmDatabase, type Database } from '../src/persistence/database';
import { runMigrations } from '../src/persistence/migrations';

/** Create a fresh in-memory database with the schema applied. */
export function makeTestDb(): Database {
  const db = createMockHcmDatabase(':memory:');
  runMigrations(db);
  return db;
}
