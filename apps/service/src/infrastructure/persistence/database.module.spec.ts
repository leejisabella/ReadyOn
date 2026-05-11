import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Database } from 'better-sqlite3';
import { DatabaseModule } from './database.module';
import { DATABASE } from './database.token';

describe('DatabaseModule', () => {
  let app: INestApplication;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('boots with migrations applied and exposes a working DB handle', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ dbPath: ':memory:' })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    const db = app.get<Database>(DATABASE);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='employee'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toEqual(['employee']);
  });

  it('applies append-only triggers only when opted in', async () => {
    // Default: triggers OFF — direct UPDATE on immutable field succeeds.
    const off = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ dbPath: ':memory:' })],
    }).compile();
    const offCtx = off.createNestApplication({ logger: false });
    await offCtx.init();
    const offDb = offCtx.get<Database>(DATABASE);
    const triggersOff = (
      offDb
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger' AND name='provisional_action_immutable_fields'`,
        )
        .get() as { c: number }
    ).c;
    expect(triggersOff).toBe(0);
    await offCtx.close();

    // Opt-in: trigger present.
    const on = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ dbPath: ':memory:', appendOnlyTriggers: true })],
    }).compile();
    app = on.createNestApplication({ logger: false });
    await app.init();
    const onDb = app.get<Database>(DATABASE);
    const triggersOn = (
      onDb
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger' AND name='provisional_action_immutable_fields'`,
        )
        .get() as { c: number }
    ).c;
    expect(triggersOn).toBe(1);
  });

  it('closes the database on application shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ dbPath: ':memory:' })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    const db = app.get<Database>(DATABASE);
    expect(db.open).toBe(true);
    await app.close();
    expect(db.open).toBe(false);
    // prevent afterEach from double-closing
    app = undefined as unknown as INestApplication;
  });
});
