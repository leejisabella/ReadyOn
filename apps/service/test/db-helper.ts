import {
  createServiceDatabase,
  type Database,
} from '../src/infrastructure/persistence/database';
import { applyAppendOnlyTriggers } from '../src/infrastructure/persistence/append-only-triggers';
import { runMigrations } from '../src/infrastructure/persistence/migrations';

export interface MakeServiceDbOptions {
  readonly appendOnlyTriggers?: boolean;
}

/** Construct a fresh in-memory service database with migrations applied. */
export function makeServiceTestDb(opts: MakeServiceDbOptions = {}): Database {
  const db = createServiceDatabase(':memory:');
  runMigrations(db);
  if (opts.appendOnlyTriggers === true) applyAppendOnlyTriggers(db);
  return db;
}
