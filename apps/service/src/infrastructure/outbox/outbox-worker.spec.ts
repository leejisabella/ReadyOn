import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { MockHcmTestHarness } from '../../../test/helpers/mock-hcm-test-harness';
import { BalanceService } from '../../domain/balance/balance.service';
import { HcmAdapterModule } from '../hcm/hcm-adapter.module';
import { DatabaseModule } from '../persistence/database.module';
import { OutboxWorker } from './outbox-worker.service';
import { OutboxModule } from './outbox.module';
import { OutboxStore, type OutboxEntryType } from './outbox.store';

interface Ctx {
  readonly harness: MockHcmTestHarness;
  readonly app: INestApplication;
  readonly store: OutboxStore;
  readonly worker: OutboxWorker;
  readonly balance: BalanceService;
  cleanup(): Promise<void>;
}

async function buildContext(workerOptions: ConstructorParameters<typeof OutboxWorker>[3] = {}): Promise<Ctx> {
  const harness = await MockHcmTestHarness.boot();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ dbPath: ':memory:' }),
      HcmAdapterModule.forRoot({
        adapter: { baseUrl: harness.baseUrl, timeoutMs: 2000 },
        healthMonitor: { unhealthyAfterFailures: 100 },
      }),
      OutboxModule.forRoot({ worker: workerOptions }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await harness.seedEmployee({
    employeeId: 'emp-1',
    employment: [{ locationId: 'loc-1', effectiveFrom: '2025-01-01' }],
    balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '10' }],
  });
  return {
    harness,
    app,
    store: app.get(OutboxStore),
    worker: app.get(OutboxWorker),
    balance: app.get(BalanceService),
    async cleanup() {
      await app.close();
      await harness.shutdown();
    },
  };
}

function enqueueMutation(
  store: OutboxStore,
  type: OutboxEntryType,
  overrides: { units?: string; idempotencyKey?: string; at?: string } = {},
): string {
  const id = randomUUID();
  store.enqueue({
    id,
    type,
    payload: {
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      units: overrides.units ?? '3',
    },
    idempotencyKey: overrides.idempotencyKey ?? `idem-${id}`,
    at: overrides.at ?? new Date().toISOString(),
  });
  return id;
}

describe('OutboxWorker', () => {
  describe('happy path', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await buildContext();
    });
    afterAll(async () => {
      await ctx.cleanup();
    });

    it('dispatches RESERVE_BALANCE: HCM debit + local balance applied + entry SUCCEEDED', async () => {
      const id = enqueueMutation(ctx.store, 'RESERVE_BALANCE');
      const result = await ctx.worker.tick();
      expect(result).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(ctx.store.find(id)?.state).toBe('SUCCEEDED');
      // local balance was updated via applyHcmUpdate (lazy-inserted at 10−3=7)
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('7');
    });

    it('dispatches RELEASE_BALANCE crediting the balance', async () => {
      // seed: reserve first to have something to release
      enqueueMutation(ctx.store, 'RESERVE_BALANCE', { units: '2' });
      await ctx.worker.tick();
      const before = ctx.balance.get('emp-1', 'loc-1', 'pto')!.available;

      enqueueMutation(ctx.store, 'RELEASE_BALANCE', { units: '2' });
      await ctx.worker.tick();
      const after = ctx.balance.get('emp-1', 'loc-1', 'pto')!.available;
      expect(after.minus(before).toFixed()).toBe('2');
    });

    it('dispatches FETCH_BALANCE: reads HCM truth into local balance', async () => {
      await ctx.harness.seedBalance({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        available: '42',
      });
      const id = randomUUID();
      ctx.store.enqueue({
        id,
        type: 'FETCH_BALANCE',
        payload: { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto' },
        idempotencyKey: `idem-${id}`,
        at: new Date().toISOString(),
      });
      await ctx.worker.tick();
      expect(ctx.store.find(id)?.state).toBe('SUCCEEDED');
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('42');
    });
  });

  describe('failure handling', () => {
    let ctx: Ctx;
    beforeEach(async () => {
      ctx = await buildContext({ maxAttempts: 2, baseBackoffMs: 100, maxBackoffMs: 100, random: () => 0 });
    });
    afterEach(async () => {
      await ctx.cleanup();
    });

    it('marks the entry FAILED_PERMANENT on INSUFFICIENT_BALANCE (4xx)', async () => {
      const id = enqueueMutation(ctx.store, 'RESERVE_BALANCE', { units: '99' });
      const result = await ctx.worker.tick();
      expect(result.permanent).toBe(1);
      const entry = ctx.store.find(id);
      expect(entry?.state).toBe('FAILED_PERMANENT');
      expect(entry?.lastError).toMatch(/HcmPermanentError/);
    });

    it('marks FAILED_PERMANENT when HCM returns EMPLOYEE_NOT_FOUND', async () => {
      await ctx.harness.deleteEmployee('emp-1');
      const id = enqueueMutation(ctx.store, 'RESERVE_BALANCE');
      await ctx.worker.tick();
      expect(ctx.store.find(id)?.state).toBe('FAILED_PERMANENT');
    });

    it('retries on transient: PENDING with advanced next_attempt_at, attempts incremented', async () => {
      // point the adapter at a closed port for one entry → transient
      const transientCtx = await buildContext({
        maxAttempts: 5,
        baseBackoffMs: 100,
        maxBackoffMs: 100,
        random: () => 0,
      });
      try {
        // Shut the mock down so the adapter sees ECONNREFUSED.
        await transientCtx.harness.shutdown();
        const id = enqueueMutation(transientCtx.store, 'RESERVE_BALANCE');
        const result = await transientCtx.worker.tick();
        expect(result.transient).toBe(1);
        const entry = transientCtx.store.find(id);
        expect(entry?.state).toBe('PENDING');
        expect(entry?.attempts).toBe(1);
        expect(new Date(entry!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() - 200);
      } finally {
        await transientCtx.app.close();
      }
    });

    it('escalates to FAILED_RETRYABLE after max attempts of transient failures', async () => {
      await ctx.harness.shutdown(); // every dispatch becomes a transient failure
      const id = enqueueMutation(ctx.store, 'RESERVE_BALANCE');

      // tick 1: attempts=1 → PENDING
      await ctx.worker.tick();
      // advance: simulate the backoff window elapsing by re-enqueueing next_attempt_at to now
      // (easier: do another tick with the next_attempt_at already in the past — set baseBackoffMs=0)
      // For this assertion, we drove maxAttempts=2; the second tick should escalate.
      // Note: claim() filters by next_attempt_at <= now; baseBackoffMs=100 so wait it out.
      await new Promise((r) => setTimeout(r, 150));
      await ctx.worker.tick();

      expect(ctx.store.find(id)?.state).toBe('FAILED_RETRYABLE');
    });
  });

  describe('idempotency on retry', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await buildContext();
    });
    afterAll(async () => {
      await ctx.cleanup();
    });

    it('uses the entry idempotency key as the HCM key — replays land the same transaction', async () => {
      // enqueue + dispatch once
      const key = `idem-${randomUUID()}`;
      enqueueMutation(ctx.store, 'RESERVE_BALANCE', { idempotencyKey: key, units: '2' });
      await ctx.worker.tick();
      const firstAvailable = ctx.balance.get('emp-1', 'loc-1', 'pto')!.available.toFixed();

      // enqueue an identical entry with the SAME key — HCM should replay
      enqueueMutation(ctx.store, 'RESERVE_BALANCE', { idempotencyKey: key, units: '2' });
      await ctx.worker.tick();
      const secondAvailable = ctx.balance.get('emp-1', 'loc-1', 'pto')!.available.toFixed();
      expect(secondAvailable).toBe(firstAvailable);
    });
  });

  describe('IN_FLIGHT recovery', () => {
    let ctx: Ctx;
    beforeAll(async () => {
      ctx = await buildContext({ inFlightTimeoutMs: 50 });
    });
    afterAll(async () => {
      await ctx.cleanup();
    });

    it('reclaims stale IN_FLIGHT rows after the timeout', async () => {
      const id = enqueueMutation(ctx.store, 'RESERVE_BALANCE', { units: '1' });
      // Manually push into IN_FLIGHT to simulate a crashed worker.
      // We do this by claiming once but then re-marking it as PENDING via raw SQL... actually
      // simpler: claim once via the store, then artificially backdate updated_at.
      const claimed = ctx.store.claim({ now: new Date().toISOString(), batchSize: 1 });
      expect(claimed[0]!.id).toBe(id);
      // Wait for the timeout window to elapse.
      await new Promise((r) => setTimeout(r, 100));
      // Next tick should sweep stale IN_FLIGHT back to PENDING and dispatch.
      const result = await ctx.worker.tick();
      expect(result.succeeded).toBe(1);
      expect(ctx.store.find(id)?.state).toBe('SUCCEEDED');
    });
  });
});
