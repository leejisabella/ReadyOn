import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { MockHcmTestHarness } from '../../test/helpers/mock-hcm-test-harness';
import { EmployeeBootstrapService } from '../domain/employee-bootstrap/employee-bootstrap.service';
import { LeaveTypeAvailabilityService } from '../domain/leave-type-availability/leave-type-availability.service';
import { HcmAdapterModule } from '../infrastructure/hcm/hcm-adapter.module';
import { HcmHealthMonitor } from '../infrastructure/hcm/hcm-health.monitor';
import { AuditEventStore } from '../infrastructure/observability/audit-event.store';
import { DatabaseModule } from '../infrastructure/persistence/database.module';
import { ProvisionalReconciler } from '../infrastructure/reconciliation/provisional-reconciler.service';
import { ApiModule } from './api.module';

/**
 * Full sustained-outage scenario, end-to-end, through the GraphQL API.
 *
 * This is the integration test the brief asks for: a single test walks an
 * employee's request from `create` through a sustained HCM outage, a manager
 * break-glass approval, HCM recovery, and reconciler drain — touching every
 * major module in the codebase.
 *
 * Steps:
 *   1. Employee creates a request                    → PENDING_APPROVAL
 *   2. HCM goes down (monitor flips UNHEALTHY)
 *   3. Outage clock advances past the break-glass threshold
 *   4. Approver invokes provisional approval         → PROVISIONALLY_APPROVED
 *   5. HCM recovers (monitor flips HEALTHY)
 *   6. ProvisionalReconciler ticks                   → APPROVED
 *   7. Assert: request state, balance, audit chain, ReconciliationStep log
 *
 * @ref docs/01_TRD.md §9.1, §9.5.1–§9.5.3
 */

const SCHEMA_PATH = join(tmpdir(), `time-off-e2e-schema-${Date.now()}.gql`);

const EMPLOYEE_HDR = { 'x-actor-id': 'emp-1', 'x-actor-role': 'employee' };
const APPROVER_HDR = { 'x-actor-id': 'mgr-1', 'x-actor-role': 'break_glass_approver' };

interface GqlResponse<T> {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{ readonly extensions?: Readonly<Record<string, unknown>> }>;
}

async function gql<T = Record<string, unknown>>(
  server: ReturnType<INestApplication['getHttpServer']>,
  query: string,
  variables: Record<string, unknown>,
  headers: Readonly<Record<string, string>>,
): Promise<GqlResponse<T>> {
  const res = await request(server).post('/graphql').set(headers).send({ query, variables });
  return res.body as GqlResponse<T>;
}

describe('E2E — sustained-outage break-glass cycle', () => {
  let harness: MockHcmTestHarness;
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let health: HcmHealthMonitor;
  let reconciler: ProvisionalReconciler;
  let audit: AuditEventStore;

  // Single fake clock drives both the health monitor and the reconciler so
  // outage durations and end-date arithmetic are deterministic.
  let nowMs = Date.UTC(2026, 4, 11, 12, 0, 0); // 2026-05-11T12:00:00Z
  const now = (): number => nowMs;

  beforeAll(async () => {
    harness = await MockHcmTestHarness.boot();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ dbPath: ':memory:' }),
        HcmAdapterModule.forRoot({
          adapter: { baseUrl: harness.baseUrl, timeoutMs: 2000 },
          healthMonitor: { unhealthyAfterFailures: 1, healthyAfterMs: 30_000, now },
        }),
        ApiModule.forRoot({
          autoSchemaFile: SCHEMA_PATH,
          request: { breakGlass: { minOutageMs: 60_000 } },
          reconciliation: {
            provisionalReconciler: {
              historyQueryWindowMs: 24 * 60 * 60 * 1_000,
              staleAfterMs: 4 * 60 * 60 * 1_000,
              leaseTtlMs: 60_000,
              workerId: 'e2e-worker',
              now,
            },
          },
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    server = app.getHttpServer();
    health = app.get(HcmHealthMonitor);
    reconciler = app.get(ProvisionalReconciler);
    audit = app.get(AuditEventStore);

    // Mock HCM ground truth
    await harness.seedEmployee({
      employeeId: 'emp-1',
      employment: [{ locationId: 'loc-1', effectiveFrom: '2025-01-01' }],
      balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '10' }],
    });
    await harness.seedLeaveTypeAvailability({
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      isActive: true,
      effectiveFrom: '2025-01-01',
    });
    // Service projections (in production the inbox processor seeds these)
    await app.get(EmployeeBootstrapService, { strict: false }).handleEmployeeCreatedEvent({
      employeeId: 'emp-1',
      hcmVersion: 1n,
      initialEmployment: { locationId: 'loc-1', effectiveFrom: '2025-01-01' },
    });
    app.get(LeaveTypeAvailabilityService, { strict: false }).applyHcmUpdate({
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      isActive: true,
      hcmVersion: 1n,
    });
  });

  afterAll(async () => {
    await app.close();
    await harness.shutdown();
  });

  it('walks PENDING_APPROVAL → break-glass → reconciliation → APPROVED', async () => {
    // ── Step 1: employee creates a request ──────────────────────────────
    const created = await gql<{
      createTimeOffRequest: { request: { id: string; state: string } };
    }>(
      server,
      /* GraphQL */ `
        mutation Create($input: CreateTimeOffRequestInput!, $key: ID!) {
          createTimeOffRequest(input: $input, idempotencyKey: $key) {
            request { id state }
          }
        }
      `,
      {
        input: {
          employeeId: 'emp-1',
          leaveTypeId: 'pto',
          startDate: '2026-05-15',
          endDate: '2026-05-17',
          units: '3',
        },
        key: 'e2e-create',
      },
      EMPLOYEE_HDR,
    );
    expect(created.errors).toBeUndefined();
    const requestId = created.data!.createTimeOffRequest.request.id;
    expect(created.data!.createTimeOffRequest.request.state).toBe('PENDING_APPROVAL');

    // ── Step 2-3: HCM goes down; outage advances past the threshold ─────
    health.recordFailure('transient');
    nowMs += 120_000; // 2-minute outage, threshold is 60s

    // hcmHealth query reflects reality
    const healthBody = await gql<{ hcmHealth: { reachable: boolean; breakGlassAvailable: boolean } }>(
      server,
      `query { hcmHealth { reachable breakGlassAvailable } }`,
      {},
      APPROVER_HDR,
    );
    expect(healthBody.data!.hcmHealth.reachable).toBe(false);
    expect(healthBody.data!.hcmHealth.breakGlassAvailable).toBe(true);

    // ── Step 4: approver invokes break-glass approval ───────────────────
    const provisional = await gql<{
      approveTimeOffRequestProvisionally: { request: { state: string; provisionalApprovalId: string } };
    }>(
      server,
      /* GraphQL */ `
        mutation BG($id: ID!, $approver: ID!, $why: String!, $key: ID!) {
          approveTimeOffRequestProvisionally(
            id: $id, approverId: $approver, justification: $why, idempotencyKey: $key
          ) {
            request { state provisionalApprovalId }
          }
        }
      `,
      {
        id: requestId,
        approver: 'mgr-1',
        why: 'HCM offline — approving so emp can fly out tonight',
        key: 'e2e-bg',
      },
      APPROVER_HDR,
    );
    expect(provisional.errors).toBeUndefined();
    expect(provisional.data!.approveTimeOffRequestProvisionally.request.state).toBe(
      'PROVISIONALLY_APPROVED',
    );
    const provisionalActionId =
      provisional.data!.approveTimeOffRequestProvisionally.request.provisionalApprovalId;
    expect(provisionalActionId).toMatch(/^[0-9a-f-]{36}$/);

    // ── Step 5: HCM recovers (monitor flips back) ───────────────────────
    health.recordSuccess();
    nowMs += 60_000; // wait the recovery window
    health.recordSuccess();
    expect(health.isHealthy()).toBe(true);

    // ── Step 6: reconciler ticks and drains the action ──────────────────
    const tick = await reconciler.tick();
    expect(tick).toMatchObject({ inspected: 1, confirmed: 1, escalated: 0, retryable: 0 });

    // ── Step 7: assert final state across every observable ──────────────
    const final = await gql<{
      timeOffRequest: {
        state: string;
        hcmTransactionId: string;
        provisionalApprovalId: string;
      };
      balance: { available: string; holds: { provisional: string } };
    }>(
      server,
      /* GraphQL */ `
        query Q($id: ID!, $e: ID!, $l: ID!, $lt: ID!) {
          timeOffRequest(id: $id) {
            state hcmTransactionId provisionalApprovalId
          }
          balance(employeeId: $e, locationId: $l, leaveTypeId: $lt) {
            available holds { provisional }
          }
        }
      `,
      { id: requestId, e: 'emp-1', l: 'loc-1', lt: 'pto' },
      EMPLOYEE_HDR,
    );
    expect(final.errors).toBeUndefined();
    expect(final.data!.timeOffRequest).toMatchObject({
      state: 'APPROVED',
      provisionalApprovalId: provisionalActionId,
    });
    expect(final.data!.timeOffRequest.hcmTransactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.data!.balance.available).toBe('7'); // 10 − 3
    expect(final.data!.balance.holds.provisional).toBe('0'); // released on reconciliation

    // Audit chain (TRD §9.5.3, §18): four events tell the story.
    expect(audit.findByEntity('TimeOffRequest', requestId).map((e) => e.action)).toEqual([
      'REQUEST_CREATED',
      'BREAK_GLASS_APPROVAL_INVOKED',
    ]);
    expect(
      audit.findByEntity('ProvisionalAction', provisionalActionId).map((e) => e.action),
    ).toEqual(['PROVISIONAL_APPROVAL_CONFIRMED']);
    expect(audit.findByEntity('Reconciler', 'e2e-worker').map((e) => e.action)).toEqual([
      'PROVISIONAL_RECONCILIATION_PASS_COMPLETED',
    ]);

    // ProvisionalAction surfaces with the full reconciliation step chain
    const detail = await gql<{
      provisionalActions: ReadonlyArray<{
        reconciliationState: string;
        reconciliationSteps: ReadonlyArray<{ kind: string; outcome: string }>;
      }>;
    }>(
      server,
      /* GraphQL */ `
        query Q($filter: ProvisionalActionFilter) {
          provisionalActions(filter: $filter) {
            reconciliationState
            reconciliationSteps { kind outcome }
          }
        }
      `,
      { filter: { requestId } },
      APPROVER_HDR,
    );
    expect(detail.errors).toBeUndefined();
    expect(detail.data!.provisionalActions).toHaveLength(1);
    expect(detail.data!.provisionalActions[0]!.reconciliationState).toBe('CONFIRMED');
    expect(detail.data!.provisionalActions[0]!.reconciliationSteps.map((s) => s.kind)).toEqual([
      'HCM_HISTORY_QUERIED',
      'HCM_CALL_IN_FLIGHT',
      'OUTCOME_APPLIED',
    ]);
  });
});
