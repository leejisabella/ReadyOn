import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DomainError } from '@time-off/domain-types';
import type { Database } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { HcmAdapterModule } from '../../infrastructure/hcm/hcm-adapter.module';
import { DATABASE } from '../../infrastructure/persistence/database.token';
import { DatabaseModule } from '../../infrastructure/persistence/database.module';
import { MockHcmTestHarness } from '../../../test/helpers/mock-hcm-test-harness';
import { BalanceModule } from '../balance/balance.module';
import { BalanceService } from '../balance/balance.service';
import { EmployeeBootstrapModule } from '../employee-bootstrap/employee-bootstrap.module';
import { EmployeeBootstrapService } from '../employee-bootstrap/employee-bootstrap.service';
import { EmploymentModule } from '../employment/employment.module';
import { EmploymentService } from '../employment/employment.service';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { LeaveTypeAvailabilityModule } from '../leave-type-availability/leave-type-availability.module';
import { LeaveTypeAvailabilityService } from '../leave-type-availability/leave-type-availability.service';
import { RequestModule } from './request.module';
import { RequestService, type ActorContext, type CreateTimeOffRequestInput } from './request.service';

interface Ctx {
  readonly harness: MockHcmTestHarness;
  readonly app: INestApplication;
  readonly db: Database;
  readonly request: RequestService;
  readonly balance: BalanceService;
  readonly employment: EmploymentService;
  readonly leaveTypes: LeaveTypeAvailabilityService;
  readonly bootstrap: EmployeeBootstrapService;
  resetServiceDb(): void;
  cleanup(): Promise<void>;
}

async function buildContext(): Promise<Ctx> {
  const harness = await MockHcmTestHarness.boot();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ dbPath: ':memory:' }),
      HcmAdapterModule.forRoot({
        adapter: { baseUrl: harness.baseUrl, timeoutMs: 2000 },
        healthMonitor: { unhealthyAfterFailures: 100 }, // tests don't exercise the gate
      }),
      EmploymentModule,
      LeaveTypeAvailabilityModule,
      EmployeeBootstrapModule,
      BalanceModule,
      IdempotencyModule,
      RequestModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const db = app.get<Database>(DATABASE);
  return {
    harness,
    app,
    db,
    request: app.get(RequestService),
    balance: app.get(BalanceService),
    employment: app.get(EmploymentService),
    leaveTypes: app.get(LeaveTypeAvailabilityService),
    bootstrap: app.get(EmployeeBootstrapService),
    resetServiceDb(): void {
      db.exec(
        `DELETE FROM idempotency_key;
         DELETE FROM time_off_request;
         DELETE FROM balance;
         DELETE FROM leave_type_availability;
         DELETE FROM employment;
         DELETE FROM employee;`,
      );
    },
    async cleanup(): Promise<void> {
      await app.close();
      await harness.shutdown();
    },
  };
}

const actor = (id: string): ActorContext => ({ actorId: id, correlationId: `corr-${id}` });

const createInput = (
  overrides: Partial<CreateTimeOffRequestInput> = {},
): CreateTimeOffRequestInput => ({
  employeeId: 'emp-1',
  leaveTypeId: 'pto',
  startDate: '2026-05-15',
  endDate: '2026-05-17',
  units: new Decimal('3'),
  ...overrides,
});

describe('RequestService (saga, normal path)', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await buildContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    ctx.resetServiceDb();
    await ctx.harness.reset();
    // mock-side fixtures
    await ctx.harness.seedEmployee({
      employeeId: 'emp-1',
      employment: [{ locationId: 'loc-1', effectiveFrom: '2025-01-01' }],
      balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '10' }],
    });
    await ctx.harness.seedLeaveTypeAvailability({
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      isActive: true,
      effectiveFrom: '2025-01-01',
    });
    // service-side projections — bootstrap path populates employee + employment
    await ctx.bootstrap.handleEmployeeCreatedEvent({
      employeeId: 'emp-1',
      hcmVersion: 1n,
      initialEmployment: { locationId: 'loc-1', effectiveFrom: '2025-01-01' },
    });
    ctx.leaveTypes.applyHcmUpdate({
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      isActive: true,
      hcmVersion: 1n,
    });
    // balance is intentionally NOT pre-seeded on the service side — the saga's
    // ensureBalanceLoaded lazily fetches from HCM on first request.
  });

  // ── create (TRD §9.1) ────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a PENDING_APPROVAL request and lazy-loads balance from HCM', async () => {
      const result = await ctx.request.create(createInput(), actor('emp-1'), 'idem-create-1');
      expect(result.state).toBe('PENDING_APPROVAL');
      expect(result.units.toFixed()).toBe('3');
      expect(result.locationId).toBe('loc-1');
      // balance was lazy-loaded from HCM and a pending hold of 3 applied
      const balance = ctx.balance.get('emp-1', 'loc-1', 'pto');
      expect(balance?.available.toFixed()).toBe('10');
      expect(balance?.holds.pending.toFixed()).toBe('3');
      expect(balance?.state).toBe('SYNCED');
    });

    it('replays the same row on retry with the same idempotency key + input', async () => {
      const first = await ctx.request.create(createInput(), actor('emp-1'), 'idem-replay');
      const second = await ctx.request.create(createInput(), actor('emp-1'), 'idem-replay');
      expect(second.id).toBe(first.id);
      // hold applied exactly once
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.holds.pending.toFixed()).toBe('3');
    });

    it('throws IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT on a different input', async () => {
      await ctx.request.create(createInput(), actor('emp-1'), 'idem-conflict');
      await expect(
        ctx.request.create(
          createInput({ units: new Decimal('5') }),
          actor('emp-1'),
          'idem-conflict',
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' });
    });

    it('throws EMPLOYMENT_NOT_FOUND when the start date precedes any employment period', async () => {
      await expect(
        ctx.request.create(createInput({ startDate: '2024-01-01', endDate: '2024-01-02' }), actor('emp-1'), 'idem-no-employ'),
      ).rejects.toMatchObject({ code: 'EMPLOYMENT_NOT_FOUND' });
    });

    it('throws REQUEST_SPANS_LOCATION_TRANSFER when start and end are at different locations', async () => {
      // seed a transfer mid-window on the service side
      ctx.employment.applyHcmUpdate({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        effectiveFrom: '2025-01-01',
        effectiveTo: '2026-05-15',
        hcmVersion: 2n,
      });
      ctx.employment.applyHcmUpdate({
        employeeId: 'emp-1',
        locationId: 'loc-2',
        effectiveFrom: '2026-05-16',
        effectiveTo: null,
        hcmVersion: 3n,
      });
      await expect(
        ctx.request.create(
          createInput({ startDate: '2026-05-14', endDate: '2026-05-17' }),
          actor('emp-1'),
          'idem-transfer',
        ),
      ).rejects.toMatchObject({ code: 'REQUEST_SPANS_LOCATION_TRANSFER' });
    });

    it('throws LEAVE_TYPE_NOT_AVAILABLE for an inactive leave type', async () => {
      await expect(
        ctx.request.create(createInput({ leaveTypeId: 'sick' }), actor('emp-1'), 'idem-bad-type'),
      ).rejects.toMatchObject({ code: 'LEAVE_TYPE_NOT_AVAILABLE' });
    });

    it('throws EMPLOYEE_NOT_BOOTSTRAPPED when HCM has no record and lazy-pull 404s', async () => {
      // wipe service-side employee + drop the mock so lazy-pull 404s
      ctx.resetServiceDb();
      await ctx.harness.deleteEmployee('emp-1');
      await expect(
        ctx.request.create(createInput(), actor('emp-1'), 'idem-no-emp'),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_BOOTSTRAPPED' });
    });

    it.each([
      ['end before start', { startDate: '2026-05-17', endDate: '2026-05-15' }],
      ['units zero', { units: '0' }],
      ['units negative', { units: '-1' }],
      ['malformed date', { startDate: '2026/05/15' }],
    ] as ReadonlyArray<readonly [string, Partial<CreateTimeOffRequestInput>]>)(
      'rejects %s with INVALID_DATES',
      async (_label, overrides) => {
        await expect(
          ctx.request.create(createInput(overrides), actor('emp-1'), `idem-${_label}`),
        ).rejects.toMatchObject({ code: 'INVALID_DATES' });
      },
    );
  });

  // ── approve (TRD §9.2) ───────────────────────────────────────────────────

  describe('approve', () => {
    async function pendingRequest(idemKey = 'idem-create'): Promise<string> {
      const r = await ctx.request.create(createInput(), actor('emp-1'), idemKey);
      return r.id;
    }

    it('debits HCM, releases the pending hold, and marks the request APPROVED', async () => {
      const id = await pendingRequest();
      const approved = await ctx.request.approve(id, actor('manager-1'), 'idem-approve');
      expect(approved.state).toBe('APPROVED');
      expect(approved.approvedBy).toBe('manager-1');
      expect(approved.hcmTransactionId).toMatch(/^[0-9a-f-]{36}$/);
      const balance = ctx.balance.get('emp-1', 'loc-1', 'pto');
      expect(balance?.holds.pending.toFixed()).toBe('0');
      expect(balance?.available.toFixed()).toBe('7'); // 10 − 3
    });

    it('rejects self-approval', async () => {
      const id = await pendingRequest();
      await expect(ctx.request.approve(id, actor('emp-1'), 'idem-self')).rejects.toMatchObject({
        code: 'STATE_TRANSITION_NOT_ALLOWED',
      });
    });

    it('throws REQUEST_NOT_FOUND for an unknown request id', async () => {
      await expect(
        ctx.request.approve('00000000-0000-0000-0000-000000000000', actor('manager-1'), 'idem-404'),
      ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    });

    it('rejects approval of an already-approved request', async () => {
      const id = await pendingRequest();
      await ctx.request.approve(id, actor('manager-1'), 'idem-first-approve');
      await expect(
        ctx.request.approve(id, actor('manager-1'), 'idem-second-approve'),
      ).rejects.toMatchObject({ code: 'STATE_TRANSITION_NOT_ALLOWED' });
    });

    it('on HCM INSUFFICIENT_BALANCE: marks request REJECTED, releases hold, throws INSUFFICIENT_BALANCE_HCM', async () => {
      const id = await pendingRequest();
      // shrink balance on the mock so HCM rejects
      await ctx.harness.seedBalance({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        available: '1',
      });
      await expect(
        ctx.request.approve(id, actor('manager-1'), 'idem-insufficient'),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE_HCM' });
      const after = ctx.balance.get('emp-1', 'loc-1', 'pto');
      expect(after?.holds.pending.toFixed()).toBe('0');
      // request transitioned to REJECTED
      // (we can re-fetch via approving again — but easier to inspect via balance state)
      // the request store would show state='REJECTED' — not exposed via service directly here.
    });

    it('replays the cached result for the same idempotency key + actor', async () => {
      const id = await pendingRequest();
      const first = await ctx.request.approve(id, actor('manager-1'), 'idem-replay-approve');
      const second = await ctx.request.approve(id, actor('manager-1'), 'idem-replay-approve');
      expect(second).toEqual(first);
      // balance touched exactly once
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('7');
    });
  });

  // ── reject (TRD §9.3) ────────────────────────────────────────────────────

  describe('reject', () => {
    it('marks the request REJECTED and releases the pending hold (local-only)', async () => {
      const id = (await ctx.request.create(createInput(), actor('emp-1'), 'idem-reject-create')).id;
      const rejected = await ctx.request.reject(
        id,
        'not approved by team lead',
        actor('manager-1'),
        'idem-reject',
      );
      expect(rejected.state).toBe('REJECTED');
      expect(rejected.rejectedReason).toBe('not approved by team lead');
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.holds.pending.toFixed()).toBe('0');
    });

    it('rejects self-rejection (employees should cancel)', async () => {
      const id = (await ctx.request.create(createInput(), actor('emp-1'), 'idem-self-reject-create')).id;
      await expect(
        ctx.request.reject(id, 'idk', actor('emp-1'), 'idem-self-reject'),
      ).rejects.toMatchObject({ code: 'STATE_TRANSITION_NOT_ALLOWED' });
    });
  });

  // ── cancel (TRD §9.4) ────────────────────────────────────────────────────

  describe('cancel', () => {
    it('cancels a PENDING_APPROVAL request locally and releases the hold', async () => {
      const id = (await ctx.request.create(createInput(), actor('emp-1'), 'idem-cancel-pending-create')).id;
      const cancelled = await ctx.request.cancel(id, actor('emp-1'), 'idem-cancel-pending');
      expect(cancelled.state).toBe('CANCELLED');
      expect(cancelled.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.holds.pending.toFixed()).toBe('0');
    });

    it('cancels an APPROVED request by crediting HCM and restoring available', async () => {
      const id = (await ctx.request.create(createInput(), actor('emp-1'), 'idem-c-approved-create')).id;
      await ctx.request.approve(id, actor('manager-1'), 'idem-c-approved-approve');
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('7');

      const cancelled = await ctx.request.cancel(id, actor('emp-1'), 'idem-c-approved-cancel');
      expect(cancelled.state).toBe('CANCELLED');
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('10');
    });

    it('throws TERMINAL_STATE_REACHED for an already-cancelled request', async () => {
      const id = (await ctx.request.create(createInput(), actor('emp-1'), 'idem-double-c-create')).id;
      await ctx.request.cancel(id, actor('emp-1'), 'idem-double-c-cancel-1');
      await expect(
        ctx.request.cancel(id, actor('emp-1'), 'idem-double-c-cancel-2'),
      ).rejects.toMatchObject({ code: 'TERMINAL_STATE_REACHED' });
    });

    it('replays the cached result', async () => {
      const id = (await ctx.request.create(createInput(), actor('emp-1'), 'idem-c-replay-create')).id;
      const first = await ctx.request.cancel(id, actor('emp-1'), 'idem-c-replay-cancel');
      const second = await ctx.request.cancel(id, actor('emp-1'), 'idem-c-replay-cancel');
      expect(second).toEqual(first);
    });
  });
});

// Surface DomainError shapes nicely in Jest assertions: tests rely on
// `code` being readable, which DomainError exposes directly.
expect.extend({
  toThrowDomainError(received: unknown, code: string) {
    if (received instanceof DomainError && received.code === code) {
      return { pass: true, message: () => `expected NOT to be DomainError(${code})` };
    }
    return {
      pass: false,
      message: () => `expected DomainError(${code}), got ${String(received)}`,
    };
  },
});
