import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MockHcmTestHarness } from '../../../test/helpers/mock-hcm-test-harness';
import { BalanceService } from '../../domain/balance/balance.service';
import { HcmAdapterModule } from '../hcm/hcm-adapter.module';
import { DatabaseModule } from '../persistence/database.module';
import { BatchReconciliation } from './batch-reconciliation.service';
import { ReconciliationModule } from './reconciliation.module';

interface Ctx {
  readonly harness: MockHcmTestHarness;
  readonly app: INestApplication;
  readonly batch: BatchReconciliation;
  readonly balance: BalanceService;
  cleanup(): Promise<void>;
}

async function buildContext(): Promise<Ctx> {
  const harness = await MockHcmTestHarness.boot();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ dbPath: ':memory:' }),
      HcmAdapterModule.forRoot({
        adapter: { baseUrl: harness.baseUrl, timeoutMs: 2000 },
      }),
      ReconciliationModule.forRoot(),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return {
    harness,
    app,
    batch: app.get(BatchReconciliation),
    balance: app.get(BalanceService),
    async cleanup() {
      await app.close();
      await harness.shutdown();
    },
  };
}

describe('BatchReconciliation', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await buildContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    await ctx.harness.reset();
  });

  it('streams every HCM balance row and applies each locally', async () => {
    await ctx.harness.seedEmployee({
      employeeId: 'emp-1',
      employment: [{ locationId: 'loc-1', effectiveFrom: '2025-01-01' }],
      balances: [
        { locationId: 'loc-1', leaveTypeId: 'pto', available: '10' },
        { locationId: 'loc-1', leaveTypeId: 'sick', available: '5' },
      ],
    });
    const result = await ctx.batch.tick();
    expect(result).toMatchObject({ inspected: 2, applied: 2, skipped: 0 });
    expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('10');
    expect(ctx.balance.get('emp-1', 'loc-1', 'sick')?.available.toFixed()).toBe('5');
  });

  it('skips entries whose hcmVersion is not newer than local — silent no-op (TRD §10.2)', async () => {
    await ctx.harness.seedEmployee({
      employeeId: 'emp-1',
      employment: [{ locationId: 'loc-1', effectiveFrom: '2025-01-01' }],
      balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '10' }],
    });
    // first drain: insert locally
    await ctx.batch.tick();
    const before = ctx.balance.get('emp-1', 'loc-1', 'pto')!.hcmVersion;
    // second drain with no HCM-side change: every row is "stale" vs local
    const second = await ctx.batch.tick();
    expect(second.applied).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.hcmVersion).toBe(before);
  });

  it('returns zero counts when HCM corpus is empty', async () => {
    const result = await ctx.batch.tick();
    expect(result).toEqual({ inspected: 0, applied: 0, skipped: 0 });
  });

  it('applies a newer hcmVersion that overwrites local state', async () => {
    await ctx.harness.seedEmployee({
      employeeId: 'emp-1',
      employment: [{ locationId: 'loc-1', effectiveFrom: '2025-01-01' }],
      balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '10' }],
    });
    await ctx.batch.tick();
    // HCM-side change bumps the version
    await ctx.harness.seedBalance({
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      available: '42',
    });
    const result = await ctx.batch.tick();
    expect(result.applied).toBe(1);
    expect(ctx.balance.get('emp-1', 'loc-1', 'pto')?.available.toFixed()).toBe('42');
  });
});
