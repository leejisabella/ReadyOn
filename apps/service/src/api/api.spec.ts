import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { MockHcmTestHarness } from '../../test/helpers/mock-hcm-test-harness';
import { EmployeeBootstrapService } from '../domain/employee-bootstrap/employee-bootstrap.service';
import { LeaveTypeAvailabilityService } from '../domain/leave-type-availability/leave-type-availability.service';
import { ApiModule } from './api.module';
import { HcmAdapterModule } from '../infrastructure/hcm/hcm-adapter.module';
import { DatabaseModule } from '../infrastructure/persistence/database.module';

interface Ctx {
  readonly harness: MockHcmTestHarness;
  readonly app: INestApplication;
  readonly server: ReturnType<INestApplication['getHttpServer']>;
  cleanup(): Promise<void>;
}

const ACTOR_HEADERS = {
  employee: { 'x-actor-id': 'emp-1', 'x-actor-role': 'employee' },
  manager: { 'x-actor-id': 'mgr-1', 'x-actor-role': 'manager' },
  approver: { 'x-actor-id': 'mgr-1', 'x-actor-role': 'break_glass_approver' },
  hr: { 'x-actor-id': 'hr-1', 'x-actor-role': 'hr_admin' },
} as const;

async function buildContext(): Promise<Ctx> {
  const harness = await MockHcmTestHarness.boot();
  const schemaPath = join(tmpdir(), `time-off-schema-${Date.now()}.gql`);
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ dbPath: ':memory:' }),
      HcmAdapterModule.forRoot({
        adapter: { baseUrl: harness.baseUrl, timeoutMs: 2000 },
      }),
      ApiModule.forRoot({ autoSchemaFile: schemaPath }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return {
    harness,
    app,
    server: app.getHttpServer(),
    async cleanup() {
      await app.close();
      await harness.shutdown();
    },
  };
}

interface GqlResponse<T> {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{ readonly message: string; readonly extensions?: Readonly<Record<string, unknown>> }>;
}

async function gql<T = Record<string, unknown>>(
  ctx: Ctx,
  query: string,
  vars: Record<string, unknown>,
  headers: Readonly<Record<string, string>>,
): Promise<GqlResponse<T>> {
  const res = await request(ctx.server)
    .post('/graphql')
    .set(headers)
    .send({ query, variables: vars });
  return res.body as GqlResponse<T>;
}

describe('GraphQL API', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await buildContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    await ctx.harness.reset();
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
    // Seed service-side projections so the saga's pre-flight checks pass.
    // (In production these come from the inbox processor + bootstrap path.)
    await ctx.app
      .get(EmployeeBootstrapService, { strict: false })
      .handleEmployeeCreatedEvent({
        employeeId: 'emp-1',
        hcmVersion: 1n,
        initialEmployment: { locationId: 'loc-1', effectiveFrom: '2025-01-01' },
      });
    ctx.app.get(LeaveTypeAvailabilityService, { strict: false }).applyHcmUpdate({
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      isActive: true,
      hcmVersion: 1n,
    });
  });

  // ── Auth boundary ────────────────────────────────────────────────────────

  it('rejects requests missing the x-actor-id header with UNAUTHENTICATED', async () => {
    const body = await gql(
      ctx,
      `query { hcmHealth { reachable } }`,
      {},
      { 'x-actor-role': 'employee' },
    );
    expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unknown x-actor-role', async () => {
    const body = await gql(
      ctx,
      `query { hcmHealth { reachable } }`,
      {},
      { 'x-actor-id': 'x', 'x-actor-role': 'janitor' },
    );
    expect(body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  // ── Mutations (TRD §9.1–§9.5) ────────────────────────────────────────────

  const CREATE = /* GraphQL */ `
    mutation Create($input: CreateTimeOffRequestInput!, $key: ID!) {
      createTimeOffRequest(input: $input, idempotencyKey: $key) {
        request { id state units startDate endDate locationId hrReviewFlag }
      }
    }
  `;
  const APPROVE = /* GraphQL */ `
    mutation Approve($id: ID!, $approverId: ID!, $key: ID!) {
      approveTimeOffRequest(id: $id, approverId: $approverId, idempotencyKey: $key) {
        request { id state approvedBy hcmTransactionId }
      }
    }
  `;
  const CANCEL = /* GraphQL */ `
    mutation Cancel($id: ID!, $actorId: ID!, $key: ID!, $ack: Boolean) {
      cancelTimeOffRequest(
        id: $id,
        actorId: $actorId,
        idempotencyKey: $key,
        acknowledgedHcmUnavailable: $ack
      ) {
        request { id state cancelledAt }
      }
    }
  `;

  it('createTimeOffRequest: happy path through GraphQL', async () => {
    const body = await gql<{
      createTimeOffRequest: { request: { id: string; state: string; units: string } };
    }>(
      ctx,
      CREATE,
      {
        input: {
          employeeId: 'emp-1',
          leaveTypeId: 'pto',
          startDate: '2026-05-15',
          endDate: '2026-05-17',
          units: '3',
        },
        key: 'k-create-1',
      },
      ACTOR_HEADERS.employee,
    );
    expect(body.errors).toBeUndefined();
    const r = body.data!.createTimeOffRequest.request;
    expect(r.state).toBe('PENDING_APPROVAL');
    expect(r.units).toBe('3');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('approveTimeOffRequest: PENDING_APPROVAL → APPROVED via the manager actor', async () => {
    const created = await gql<{ createTimeOffRequest: { request: { id: string } } }>(
      ctx,
      CREATE,
      {
        input: { employeeId: 'emp-1', leaveTypeId: 'pto', startDate: '2026-05-15', endDate: '2026-05-17', units: '3' },
        key: 'k-create-app',
      },
      ACTOR_HEADERS.employee,
    );
    const id = created.data!.createTimeOffRequest.request.id;

    const approved = await gql<{
      approveTimeOffRequest: { request: { state: string; approvedBy: string } };
    }>(
      ctx,
      APPROVE,
      { id, approverId: 'mgr-1', key: 'k-approve-1' },
      ACTOR_HEADERS.manager,
    );
    expect(approved.errors).toBeUndefined();
    expect(approved.data!.approveTimeOffRequest.request.state).toBe('APPROVED');
    expect(approved.data!.approveTimeOffRequest.request.approvedBy).toBe('mgr-1');
  });

  it('cancelTimeOffRequest with acknowledgedHcmUnavailable=true routes to the provisional path', async () => {
    // create + approve so the request is APPROVED locally
    const created = await gql<{ createTimeOffRequest: { request: { id: string } } }>(
      ctx,
      CREATE,
      {
        input: { employeeId: 'emp-1', leaveTypeId: 'pto', startDate: '2026-05-15', endDate: '2026-05-17', units: '3' },
        key: 'k-c-pc-create',
      },
      ACTOR_HEADERS.employee,
    );
    const id = created.data!.createTimeOffRequest.request.id;
    await gql(ctx, APPROVE, { id, approverId: 'mgr-1', key: 'k-c-pc-approve' }, ACTOR_HEADERS.manager);

    const cancelled = await gql<{
      cancelTimeOffRequest: { request: { state: string } };
    }>(
      ctx,
      CANCEL,
      { id, actorId: 'emp-1', key: 'k-c-pc', ack: true },
      ACTOR_HEADERS.employee,
    );
    expect(cancelled.errors).toBeUndefined();
    expect(cancelled.data!.cancelTimeOffRequest.request.state).toBe('CANCELLATION_PENDING');
  });

  // ── Error mapping ─────────────────────────────────────────────────────────

  it('DomainError surfaces as a GraphQLError with extensions.code', async () => {
    const body = await gql(
      ctx,
      CANCEL,
      {
        id: '00000000-0000-0000-0000-000000000000',
        actorId: 'emp-1',
        key: 'k-404',
        ack: false,
      },
      ACTOR_HEADERS.employee,
    );
    expect(body.errors).toBeDefined();
    expect(body.errors![0]!.extensions?.code).toBe('REQUEST_NOT_FOUND');
    expect(body.errors![0]!.extensions?.retryable).toBe('no');
  });

  it('arg/header actor mismatch is rejected (defense in depth)', async () => {
    const body = await gql(
      ctx,
      CREATE,
      {
        input: {
          employeeId: 'someone-else',
          leaveTypeId: 'pto',
          startDate: '2026-05-15',
          endDate: '2026-05-17',
          units: '3',
        },
        key: 'k-impersonation',
      },
      ACTOR_HEADERS.employee,
    );
    expect(body.errors?.[0]?.extensions?.code).toBe('STATE_TRANSITION_NOT_ALLOWED');
  });

  // ── Queries ───────────────────────────────────────────────────────────────

  it('hcmHealth: returns reachable=true under a healthy mock and breakGlassAvailable=false for non-approvers', async () => {
    const body = await gql<{
      hcmHealth: { reachable: boolean; breakGlassAvailable: boolean };
    }>(ctx, `query { hcmHealth { reachable breakGlassAvailable } }`, {}, ACTOR_HEADERS.manager);
    expect(body.errors).toBeUndefined();
    expect(body.data!.hcmHealth.reachable).toBe(true);
    expect(body.data!.hcmHealth.breakGlassAvailable).toBe(false);
  });

  it('balance query returns the same row the saga sees locally', async () => {
    // run a create+approve so the balance gets debited
    const created = await gql<{ createTimeOffRequest: { request: { id: string } } }>(
      ctx,
      CREATE,
      {
        input: { employeeId: 'emp-1', leaveTypeId: 'pto', startDate: '2026-05-15', endDate: '2026-05-17', units: '3' },
        key: 'k-bal-create',
      },
      ACTOR_HEADERS.employee,
    );
    await gql(
      ctx,
      APPROVE,
      { id: created.data!.createTimeOffRequest.request.id, approverId: 'mgr-1', key: 'k-bal-approve' },
      ACTOR_HEADERS.manager,
    );
    const body = await gql<{ balance: { available: string; holds: { approved: string } } }>(
      ctx,
      `query Q($e: ID!, $l: ID!, $lt: ID!) {
         balance(employeeId: $e, locationId: $l, leaveTypeId: $lt) {
           available holds { approved pending provisional }
         }
       }`,
      { e: 'emp-1', l: 'loc-1', lt: 'pto' },
      ACTOR_HEADERS.employee,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.balance.available).toBe('7');
  });

  it('hrReviewQueue: empty by default; surfaces totalCount=0 and no edges', async () => {
    const body = await gql<{
      hrReviewQueue: {
        edges: ReadonlyArray<{ cursor: string; node: { request: { id: string } } }>;
        totalCount: number;
        pageInfo: { hasNextPage: boolean };
      };
    }>(
      ctx,
      `query { hrReviewQueue { totalCount edges { cursor node { request { id } } } pageInfo { hasNextPage } } }`,
      {},
      ACTOR_HEADERS.hr,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.hrReviewQueue.totalCount).toBe(0);
    expect(body.data!.hrReviewQueue.edges).toEqual([]);
    expect(body.data!.hrReviewQueue.pageInfo.hasNextPage).toBe(false);
  });
});
