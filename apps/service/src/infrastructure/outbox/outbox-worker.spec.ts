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
        // next_attempt_at must be in the future — the backoff is applied as
        // `now + backoffMs`, never `now - backoffMs`.
        expect(new Date(entry!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
      } finally {
        await transientCtx.app.close();
      }
    });

    it('marks SUSPECT_NO_OP and increments result.suspectNoOp on HcmContractViolation (TRD §13.3)', async () => {
      // silent_no_op mode: HCM returns 200 but deltaApplied=0. The adapter
      // raises HcmContractViolation; the worker must route it to a distinct
      // counter and a non-terminal "suspect" state.
      await ctx.harness.setMode('silent_no_op');
      const id = enqueueMutation(ctx.store, 'RESERVE_BALANCE');
      const result = await ctx.worker.tick();
      expect(result.suspectNoOp).toBe(1);
      expect(result.permanent).toBe(0);
      expect(result.transient).toBe(0);
      const entry = ctx.store.find(id);
      expect(entry?.state).toBe('SUSPECT_NO_OP');
    });

    it('fails permanently for BOOTSTRAP_EMPLOYEE / RECONCILE_PROVISIONAL — TRD §10.3 reserves these types but they have no outbox producer', async () => {
      const id = randomUUID();
      ctx.store.enqueue({
        id,
        type: 'BOOTSTRAP_EMPLOYEE',
        payload: { employeeId: 'emp-1' },
        idempotencyKey: `idem-${id}`,
        at: new Date().toISOString(),
      });
      const result = await ctx.worker.tick();
      expect(result.permanent).toBe(1);
      const entry = ctx.store.find(id);
      expect(entry?.state).toBe('FAILED_PERMANENT');
      expect(entry?.lastError).toMatch(/no producer/);
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

    it('does not reclaim a freshly-claimed IN_FLIGHT row (the cutoff is `now - inFlightTimeoutMs`, not `now + ...`)', async () => {
      // A long timeout means a freshly-claimed entry is well within the window;
      // it must stay IN_FLIGHT until the worker that owns it completes. If the
      // cutoff arithmetic flipped sign (`now + timeout`), every IN_FLIGHT row
      // would be older than the (future) cutoff and incorrectly reclaimed.
      const freshCtx = await buildContext({ inFlightTimeoutMs: 10 * 60_000 });
      try {
        const id = enqueueMutation(freshCtx.store, 'RESERVE_BALANCE', { units: '1' });
        const claimed = freshCtx.store.claim({ now: new Date().toISOString(), batchSize: 1 });
        expect(claimed[0]!.id).toBe(id);
        expect(freshCtx.store.find(id)?.state).toBe('IN_FLIGHT');
        // Sweep with the same `now`: nothing stale yet.
        const result = await freshCtx.worker.tick();
        expect(result.claimed).toBe(0);
        expect(freshCtx.store.find(id)?.state).toBe('IN_FLIGHT');
      } finally {
        await freshCtx.cleanup();
      }
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

  // Direct-instantiation unit tests for the pure backoff arithmetic. Skips the
  // NestJS / HCM / DB scaffolding because none of those dependencies are
  // exercised by `backoffMs`.
  describe('backoffMs (TRD §16: baseBackoffMs, maxBackoffMs)', () => {
    const build = (opts: ConstructorParameters<typeof OutboxWorker>[3]): OutboxWorker =>
      new OutboxWorker({} as never, {} as never, {} as never, opts);

    it('returns base * 2^attempts plus deterministic jitter (random=0.5)', () => {
      const worker = build({ baseBackoffMs: 10, maxBackoffMs: 10_000, random: () => 0.5 });
      const backoff = (worker as unknown as { backoffMs(a: number): number }).backoffMs.bind(worker);
      // exp = min(10_000, 10 * 1) = 10; jitter = 10 * 0.25 * 0.5 = 1.25; total = 11.25.
      expect(backoff(0)).toBeCloseTo(11.25);
      // exp = min(10_000, 10 * 4) = 40; jitter = 40 * 0.25 * 0.5 = 5; total = 45.
      expect(backoff(2)).toBeCloseTo(45);
    });

    it('caps exponential growth at maxBackoffMs', () => {
      const worker = build({ baseBackoffMs: 1, maxBackoffMs: 100, random: () => 0 });
      const backoff = (worker as unknown as { backoffMs(a: number): number }).backoffMs.bind(worker);
      // 1 * 2^20 = 1_048_576, capped at 100.
      expect(backoff(20)).toBe(100);
    });

    it('caps exp+jitter at maxBackoffMs', () => {
      const worker = build({ baseBackoffMs: 100, maxBackoffMs: 100, random: () => 1 });
      const backoff = (worker as unknown as { backoffMs(a: number): number }).backoffMs.bind(worker);
      // exp = 100 (already at cap); jitter = 25; total clamps at 100.
      expect(backoff(0)).toBe(100);
    });

    it('honours retryAfterMs when supplied, capped at maxBackoffMs', () => {
      const worker = build({ baseBackoffMs: 10, maxBackoffMs: 1_000, random: () => 0 });
      const backoff = (worker as unknown as {
        backoffMs(a: number, r?: number): number;
      }).backoffMs.bind(worker);
      expect(backoff(5, 50)).toBe(50); // under cap → honoured
      expect(backoff(5, 10_000)).toBe(1_000); // over cap → clamped
    });
  });
});
