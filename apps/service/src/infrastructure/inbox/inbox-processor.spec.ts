import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MockHcmTestHarness } from '../../../test/helpers/mock-hcm-test-harness';
import { BalanceService } from '../../domain/balance/balance.service';
import { EmployeeBootstrapService } from '../../domain/employee-bootstrap/employee-bootstrap.service';
import { EmploymentService } from '../../domain/employment/employment.service';
import { LeaveTypeAvailabilityService } from '../../domain/leave-type-availability/leave-type-availability.service';
import { HcmAdapterModule } from '../hcm/hcm-adapter.module';
import { ObservabilityModule } from '../observability/observability.module';
import { DatabaseModule } from '../persistence/database.module';
import { InboxProcessor } from './inbox-processor.service';
import { InboxModule } from './inbox.module';
import { InboxStore } from './inbox.store';

interface Ctx {
  readonly harness: MockHcmTestHarness;
  readonly app: INestApplication;
  readonly store: InboxStore;
  readonly processor: InboxProcessor;
  readonly balance: BalanceService;
  readonly employment: EmploymentService;
  readonly leaveTypes: LeaveTypeAvailabilityService;
  readonly bootstrap: EmployeeBootstrapService;
  cleanup(): Promise<void>;
}

async function buildContext(): Promise<Ctx> {
  const harness = await MockHcmTestHarness.boot();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ dbPath: ':memory:' }),
      ObservabilityModule.forRoot(),
      HcmAdapterModule.forRoot({
        adapter: { baseUrl: harness.baseUrl, timeoutMs: 2000 },
      }),
      InboxModule.forRoot({ webhookSecret: 'test-secret' }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return {
    harness,
    app,
    store: app.get(InboxStore),
    processor: app.get(InboxProcessor),
    balance: app.get(BalanceService),
    employment: app.get(EmploymentService),
    leaveTypes: app.get(LeaveTypeAvailabilityService),
    bootstrap: app.get(EmployeeBootstrapService),
    async cleanup() {
      await app.close();
      await harness.shutdown();
    },
  };
}

describe('InboxProcessor', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await buildContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  describe('routes events to the right domain service', () => {
    it('BALANCE_UPDATED applies via BalanceService', async () => {
      ctx.store.ingest({
        id: 'evt-balance',
        source: 'WEBHOOK',
        type: 'BALANCE_UPDATED',
        payload: { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', available: '15' },
        hcmVersion: 5n,
        receivedAt: new Date().toISOString(),
      });
      const result = await ctx.processor.tick();
      expect(result).toMatchObject({ processed: 1, failed: 0 });
      expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('15');
    });

    it('EMPLOYMENT_CHANGED applies via EmploymentService', async () => {
      ctx.store.ingest({
        id: 'evt-employment',
        source: 'WEBHOOK',
        type: 'EMPLOYMENT_CHANGED',
        payload: { employeeId: 'emp-2', locationId: 'loc-A', effectiveFrom: '2025-01-01' },
        hcmVersion: 7n,
        receivedAt: new Date().toISOString(),
      });
      await ctx.processor.tick();
      expect(ctx.employment.locationAt('emp-2', '2025-06-01')).toBe('loc-A');
    });

    it('LEAVE_TYPE_CHANGED applies via LeaveTypeAvailabilityService', async () => {
      ctx.store.ingest({
        id: 'evt-leave',
        source: 'WEBHOOK',
        type: 'LEAVE_TYPE_CHANGED',
        payload: {
          locationId: 'loc-X',
          leaveTypeId: 'parental',
          isActive: true,
          effectiveFrom: '2025-01-01',
        },
        hcmVersion: 3n,
        receivedAt: new Date().toISOString(),
      });
      await ctx.processor.tick();
      expect(ctx.leaveTypes.isActive('loc-X', 'parental', '2025-06-01')).toBe(true);
    });

    it('EMPLOYEE_CREATED applies via EmployeeBootstrapService', async () => {
      ctx.store.ingest({
        id: 'evt-new-hire',
        source: 'WEBHOOK',
        type: 'EMPLOYEE_CREATED',
        payload: {
          employeeId: 'emp-new',
          employment: { locationId: 'loc-1', effectiveFrom: '2026-01-01' },
        },
        hcmVersion: 1n,
        receivedAt: new Date().toISOString(),
      });
      await ctx.processor.tick();
      expect(ctx.employment.locationAt('emp-new', '2026-06-01')).toBe('loc-1');
    });
  });

  it('processes nothing when the queue is empty', async () => {
    const result = await ctx.processor.tick();
    expect(result).toEqual({ claimed: 0, processed: 0, failed: 0 });
  });

  it('records processingError for malformed payloads — row stays unprocessed for retry', async () => {
    ctx.store.ingest({
      id: 'evt-bad',
      source: 'WEBHOOK',
      type: 'BALANCE_UPDATED',
      payload: { employeeId: 'emp-1' }, // missing locationId/leaveTypeId/available
      hcmVersion: 1n,
      receivedAt: new Date().toISOString(),
    });
    const result = await ctx.processor.tick();
    expect(result).toMatchObject({ failed: 1, processed: 0 });
    const row = ctx.store.find('evt-bad');
    expect(row?.processedAt).toBeNull();
    expect(row?.processingError).toMatch(/locationId/);
    // quarantine so subsequent runs see an empty queue
    ctx.store.markProcessed('evt-bad', new Date().toISOString());
  });
});
