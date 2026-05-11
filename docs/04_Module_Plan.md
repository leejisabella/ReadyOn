# Module Plan & Code Organization

**Status:** Revision 3.1
**Companion to:** `00_Cover_and_Reasoning.md`, `01_TRD.md`, `02_Assumptions_and_Decisions.md`, `03_Test_Plan.md`

This document describes the planned NestJS module layout, file organization, key abstractions, and code-level conventions an agentic developer should produce. No production code is written here per the brief; this document is the contract the implementer (agent or human) follows.

The reader should be able to predict, before any code exists, where any given concern will live and how every cross-cutting choice in `01_TRD.md` is realized in the code organization.

---

## CHANGELOG (since Revision 3)

Rev 3.1 patch closes six open questions from Rev 3 review. Module hierarchy gains one new repository; existing files extend.

- **§2 (UPDATED):** `ReconcilerLeaseRepository` added to ReconciliationModule (Q.ι).
- **§3.7.1 (UPDATED, Q.θ):** Append-only allow-list grows to five fields; `markReconciled` signature updated.
- **§3.15.1 (UPDATED, Q.ι, Q.κ, Q.λ, Q.ν):** New files in `reconciliation/provisional/` for the lock primitive, employee-deletion handling, stale-alert wiring.
- **§3.7.6 (UPDATED, Q.μ):** `HrReviewQueueService` returns paginated connection; cursor encoding/decoding utilities added.
- **§5.7 (UPDATED, Q.ι):** `AdvisoryLock` interface added.
- **§5.10 (UPDATED, Q.ν):** `ReconciliationStepKind` enum extended.
- **§5.11 (UPDATED, Q.μ):** `HrReviewQueueService` interface returns `HrReviewItemConnection`.
- **§5.13 (NEW, Q.ι):** `ReconcilerLeaseRepository` interface.
- **§5.14 (NEW, Q.λ):** `MetricsAdapter` interface (no-op default, Prometheus in production).
- **§6 (UPDATED):** TSDoc convention extended with `@metric` tag for methods that emit metric samples.
- **§9 (UPDATED):** Snapshot summarization conventions added.

---

## CHANGELOG (since Revision 2)

- **§2 (UPDATED):** Module hierarchy adds `HrReviewModule` (consumes data from RequestModule, BalanceModule, ProvisionalActionModule) and updates `ReconciliationModule` for the formalized provisional reconciler.
- **§3.7 (UPDATED, Q.δ):** `ProvisionalActionModule` documents append-only repository convention with allow-listed update fields. Optional SQLite trigger noted.
- **§3.15 (UPDATED, Q.γ):** `ReconciliationModule` documents the formalized provisional reconciler algorithm with pre-flight history query, ReconciliationStep event log, and advisory locking.
- **§3.X (NEW, Q.γ, Q.δ):** New module `ReconciliationStepModule` housing the strictly-append-only step log repository.
- **§3.Y (NEW, Q.β):** New module `HrReviewModule` exposing the `hrReviewQueue` GraphQL query.
- **§5.7 (UPDATED, Q.γ):** `ProvisionalReconciler` interface formalized with explicit history-query precondition.
- **§5.10 (NEW, Q.γ):** `ReconciliationStepRepository` interface — single insert method only.
- **§5.11 (NEW, Q.β):** `HrReviewQueueService` interface.
- **§7 (UPDATED, Q.ε):** `MockHcmTestHarness` file location and structure specified — single class under `apps/service/test/helpers/`.
- **§8.2 (UPDATED, Q.γ):** Worker discipline pseudocode updated for the formalized provisional reconciler.
- **§10 (UPDATED, Q.α):** Error mapping for new error codes; cancel-acknowledgment contract.
- **§11 (UPDATED):** README requirements expanded with HR Review runbook and provisional-reconciler runbook.

---

## CHANGELOG (since Revision 1, preserved)

- **§2:** Module hierarchy extended with `EmployeeBootstrapModule`, `ProvisionalActionModule`, `HcmHealthModule`, extension of `ReconciliationModule`, `HcmAdapterModule`.
- **§3:** New module responsibilities documented in detail.
- **§5:** New critical interfaces: `HcmHealthMonitor`, `BreakGlassAuthorizer`, `ProvisionalReconciler`, `EmployeeBootstrapService`, `CanonicalInputSerializer`.
- **§6:** Documentation conventions expanded.
- **§8:** Worker discipline pseudocode extended.
- **§9:** Decimal handling cross-cutting conventions added.
- **§10:** Mock HCM persistence reflected.
- **§11:** README requirements expanded.

---

## Table of Contents

1. [Top-level repository layout](#1-top-level-repository-layout)
2. [Service module hierarchy](#2-service-module-hierarchy)
3. [Module responsibilities](#3-module-responsibilities)
4. [Mock HCM module hierarchy](#4-mock-hcm-module-hierarchy)
5. [Critical interfaces](#5-critical-interfaces)
6. [Documentation conventions inside the codebase](#6-documentation-conventions-inside-the-codebase)
7. [Test file organization](#7-test-file-organization)
8. [Worker discipline (polling outbox, inbox, reconcilers)](#8-worker-discipline)
9. [Decimal handling conventions (cross-cutting)](#9-decimal-handling-conventions)
10. [Error handling & logging conventions](#10-error-handling--logging-conventions)
11. [Build, deployment, and README requirements](#11-build-deployment-and-readme-requirements)

---

## 1. Top-level repository layout

```
time-off-microservice/
├── apps/
│   ├── service/                          # Main NestJS service
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── api/                      # GraphQL layer (resolvers, DTOs, mappers)
│   │   │   ├── domain/                   # Domain modules (request, balance, employment, …)
│   │   │   ├── infrastructure/           # DB, HCM port, health monitor, audit
│   │   │   ├── workers/                  # Outbox, Inbox, Reconcilers
│   │   │   └── common/                   # Canonical serializer, decimal scalar, AsyncLocalStorage
│   │   ├── test/
│   │   └── tsconfig.json
│   └── mock-hcm/                         # Separate Mock HCM Nest app
│       ├── src/
│       │   ├── main.ts
│       │   ├── api/                      # HCM-shaped endpoints
│       │   ├── admin/                    # Test-driving endpoints
│       │   ├── adversarial/              # Mode controller (nine modes)
│       │   ├── webhook-emitter/          # Outbound webhook firing
│       │   ├── persistence/              # Own SQLite store (durable)
│       │   └── scheduler/                # Anniversary, refresh, etc.
│       └── test/
├── libs/
│   ├── domain-types/                     # Shared types: DTOs, enums, ErrorCode, RequestState
│   ├── hcm-port/                         # HcmPort interface + zod schemas
│   └── decimal-scalar/                   # GraphQL Decimal scalar + canonicalization helpers
├── docs/
│   ├── 00_Cover_and_Reasoning.md         # Synthesis and design narrative
│   ├── 01_TRD.md
│   ├── 02_Assumptions_and_Decisions.md
│   ├── 03_Test_Plan.md
│   └── 04_Module_Plan.md                 # this file
│   └── operations/
│       ├── break-glass-runbook.md
│       ├── bootstrap-runbook.md
│       └── reconciliation-runbook.md
├── scripts/
│   ├── bootstrap-db.ts                   # Run migrations
│   ├── seed-mock-hcm.ts                  # Seed deterministic fixtures
│   └── replay-provisional-actions.ts     # HR-facing recovery tool (boundary-defined)
├── package.json
├── nest-cli.json
├── docker-compose.yml                    # Brings up service + mock-hcm
└── README.md
```

Monorepo with two deployable apps and shared libraries. NestJS-native monorepo conventions (no Nx required, but compatible with it).

---

## 2. Service module hierarchy

```
AppModule
├── ConfigModule                          # Typed config (TRD §16)
├── DatabaseModule                        # SQLite + TypeORM (WAL mode, ≥ 3.35)
├── ApiModule                             # GraphQL resolvers
├── AuthModule                            # Gateway-header guard, role checks
├── AuditModule                           # Append-only audit logging
├── DomainModules:
│   ├── EmployeeBootstrapModule           # Rev 2: webhook + lazy pull + batch
│   ├── EmploymentModule                  # Employment timeline projection
│   ├── LeaveTypeAvailabilityModule
│   ├── BalanceModule                     # Balance projection + holds (pending/approved/provisional)
│   ├── RequestModule                     # Request lifecycle + saga
│   ├── ProvisionalActionModule           # Rev 2: append-only event log of break-glass actions
│   ├── ReconciliationStepModule          # Rev 3 NEW: strictly-append-only step log (Q.γ, Q.δ)
│   ├── HrReviewModule                    # Rev 3 NEW: hrReviewQueue surface (Q.β)
│   └── IdempotencyModule                 # Canonical-key resolution
├── InfrastructureModules:
│   ├── HcmAdapterModule                  # Port + chosen adapter (Rev 3: includes queryTransactions)
│   ├── HcmHealthModule                   # Rev 2: reachability tracker with hysteresis
│   ├── OutboxModule                      # Outbox table + claim helpers
│   └── InboxModule                       # Inbox + webhook receiver
└── WorkerModules:
    ├── OutboxWorkerModule                # Drains outbox
    ├── InboxProcessorModule              # Drains inbox
    └── ReconciliationModule              # Three normal cadences + formalized provisional reconciler (Rev 3)
```

Each module exposes a small public service interface and keeps repositories internal. Cross-module calls go through services, never repositories.

---

## 3. Module responsibilities

### 3.1 ApiModule

- GraphQL schema definition (code-first; type-safe DTOs from TypeScript).
- Resolvers are thin: parse input, call domain service, format output.
- DataLoader for Balance and Request batching.
- Maps domain errors to GraphQL `DomainError` payloads via a single `ErrorMapper`.
- No business logic.

**Files:**
- `api/api.module.ts`
- `api/resolvers/{balance,request,employment,leaveType,health,internal}.resolver.ts`
- `api/dto/*.dto.ts`
- `api/dataloaders/*.loader.ts`
- `api/error.mapper.ts`
- `api/scalars/decimal.scalar.ts`

### 3.2 RequestModule

- The saga orchestrator.
- Owns `RequestState` transitions.
- Calls into BalanceModule, EmploymentModule, LeaveTypeAvailabilityModule for validation.
- Calls HcmAdapterModule for live HCM verification (when reachable).
- Calls BreakGlassAuthorizer + ProvisionalActionModule for break-glass approvals.
- Inserts outbox entries for async work.
- Emits AuditEvents for every state transition.

**Key services:**
- `RequestService` — public interface (create, approve, approveProvisionally, reject, cancel, revalidate).
- `RequestSaga` — internal coordinator, one method per saga step.
- `RequestStateMachine` — pure state-transition rules; rejects illegal transitions.
- `RequestRepository` — DB access.

### 3.3 BalanceModule

- Owns the Balance projection.
- Provides read API (current available, netAvailable computed from holds).
- Manages `pendingHold`, `approvedHold`, `provisionalHold` mutations.
- Emits BalanceState transitions.
- Consumes inbox events for HCM-driven updates (via subscription pattern; events delivered by InboxProcessorModule).

**Key services:**
- `BalanceService`.
- `BalanceRepository`.
- `HoldAccountant` — pure logic for hold arithmetic and invariant checks across all three hold buckets.

### 3.4 EmploymentModule

- Owns the Employment timeline projection.
- Provides `locationAt(employeeId, date)` lookup.
- Consumes inbox events for employment changes.
- Triggers revalidation pass on pending requests after a change (publishes to RequestModule via internal event bus).

**Key services:**
- `EmploymentService`.
- `EmploymentRepository`.

### 3.5 LeaveTypeAvailabilityModule

- Owns the `LeaveTypeAvailability` projection.
- Provides `isActive(locationId, leaveTypeId, asOfDate)` lookup.
- Consumes inbox events for leave-type changes.
- Triggers revalidation when types appear/disappear.

### 3.6 EmployeeBootstrapModule (NEW)

- Implements three bootstrap paths: webhook (from inbox), lazy pull (on first reference), batch (during reconciliation).
- All three converge on `Employee` table inserts using `INSERT OR IGNORE` semantics for idempotency.

**Key services:**
- `EmployeeBootstrapService` — public interface: `ensureBootstrapped(employeeId)`, `handleEmployeeCreatedEvent(event)`, `bootstrapFromBatch(row)`.
- `EmployeeRepository`.

**Cross-module contract:** any service handling an `employeeId` from user input or HCM input first calls `ensureBootstrapped`. This is enforced by interceptor at API entry where possible, and by explicit calls in inbox processors elsewhere.

### 3.7 ProvisionalActionModule (event-sourced)

- Append-only event log of every break-glass decision.
- Consumed by ProvisionalReconciler (in ReconciliationModule) when HCM recovers.

**Key services:**
- `ProvisionalActionService.record(action)` — append a new event with full local snapshot.
- `ProvisionalActionService.listPending()` — for the reconciler.
- `ProvisionalActionService.markReconciled(id, result)` — terminal transition.
- `ProvisionalActionRepository`.

**Design note.** This is event-driven architecture *at the boundary*. The provisional reconciler is a consumer; the API mutation is a producer. The local request state and the `ProvisionalAction` row are written atomically in the same transaction so the event log can never lose a decision.

#### 3.7.1 Append-only convention (Rev 3, Q.δ; updated Rev 3.1, Q.θ)

The `ProvisionalActionRepository` exposes only two mutation methods:

- `insert(row)` — used at break-glass invocation. Sets `reconciliationState = PENDING`. Stores full `localStateSnapshot`.
- `markReconciled(actionId, finalState, details, summary, nullifySnapshot)` — used by the reconciler. Atomically updates the **five** allow-listed fields: `reconciliationState`, `reconciledAt`, `reconciliationDetails`, `localStateSnapshot` (only to null on success/no-op when `nullifySnapshot=true`), `localStateSnapshotSummary` (always on terminal). The input is validated via a strict zod schema that whitelists only those five fields. Throws if any other field is touched.

There is **no `update(...)` method** on the repository. There is **no `delete(...)` method**. Code that needs to read pending actions calls `listPending()`; code that needs to record a terminal outcome calls `markReconciled()`. No other write path exists.

**Rev 3.1 retention behavior (Q.θ).** The `markReconciled` caller decides whether to null out the snapshot:

- ESCALATED outcomes → `nullifySnapshot = false` (retain full snapshot for HR investigation).
- CONFIRMED, NO_OP outcomes → `nullifySnapshot = true` (replace with summary).
- The behavior is gated by `reconciler.snapshotRetention.summarizeAfterSuccess`; if false, `nullifySnapshot` is forced to false regardless of outcome.

**Optional belt-and-suspenders:** a SQLite trigger may be added (controlled by `migration.appendOnlyTriggers: true` in config) that rejects any `UPDATE` outside the allow-listed columns and any `DELETE` on the table. The trigger SQL is generated from the same allow-list to keep them in lockstep.

**Test obligation:** unit tests verify that off-allow-list updates are rejected by the repository (regardless of trigger state); verify retention policy on CONFIRMED, NO_OP, and ESCALATED outcomes; verify the config knob disables summarization. See `03_Test_Plan.md` Layer 21 (T-PR-EX-19/20/21).

### 3.7.5 ReconciliationStepModule (NEW in Rev 3, Q.γ + Q.δ)

The strictly-append-only step log for the provisional reconciler. One row per step the reconciler takes; the row records what happened, with what inputs/outputs, by which worker.

**Why a separate module from ProvisionalActionModule?** ProvisionalAction has limited updates allowed (on three fields). ReconciliationStep has no updates whatsoever. Separating them makes the contract clearer at the schema level and prevents accidental crossover.

**Key services:**
- `ReconciliationStepService.append(step)` — the only write operation. Inserts a row.
- `ReconciliationStepService.findLastForAction(actionId)` — read; used by reconciler for crash-recovery resume decisions.
- `ReconciliationStepService.findAllForAction(actionId)` — read; used by HR Review surface and audit-chain queries.
- `ReconciliationStepRepository`.

**Repository surface:**
- `insert(row)` — only mutation method.
- No `update`, no `delete`, no exceptions.

**Event-driven implications.** The step log is the durable event stream for the reconciler. Reading it back reconstructs the reconciler's decision history without consulting in-memory state. This is what makes crash recovery deterministic.

### 3.7.6 HrReviewModule (NEW in Rev 3, Q.β; paginated in Rev 3.1, Q.μ)

Exposes the `hrReviewQueue` GraphQL query and the data feed behind it. Stateless read-side module that joins data from RequestModule, ProvisionalActionModule, and ReconciliationStepModule.

**Key services:**
- `HrReviewQueueService.list(filter, pagination)` — returns `HrReviewItemConnection` with edges, pageInfo, and totalCount.
- `CursorCodec` — encodes/decodes the opaque cursor (base64-encoded JSON `{flaggedAt, id}`).

**Categories surfaced:**
1. `ESCALATED_PRE_LEAVE` — request.state == ESCALATED_TO_HR.
2. `ESCALATED_POST_LEAVE` — request.state == TAKEN AND hrReviewFlag == true.
3. `CANCELLATION_STUCK` — request.state == CANCELLATION_PENDING AND age > threshold.

**Pagination (Rev 3.1, Q.μ).**
- Default page size 50; max 200 (clamped silently with Warning extension).
- Order: `flaggedAt DESC`, stable secondary order by `request.id`.
- Cursor is opaque; format is implementation detail.
- Forward pagination only (`first`, `after`); reverse is future work.
- `totalCount` is computed against the filter; index on `(category, flaggedAt)` keeps it bounded.

**Auth.** Resolver requires `hr_admin` role (boundary header `x-actor-role`).

**Design note.** This module is purely a read-side query layer. It owns no write paths. New categories can be added without state-machine changes; the categorization logic lives in `HrReviewQueueService`. The pagination implementation is the standard Relay-style pattern that the rest of the GraphQL surface can adopt over time.

### 3.8 IdempotencyModule

- Stores `(key, inputHash, responseSnapshot)`.
- Provides `resolve(key, inputHash)` returning `Found(response) | Conflict | NotFound`.
- TTL-based cleanup as a periodic task.
- Shared by all mutating resolvers via decorator / interceptor.
- Uses `CanonicalInputSerializer` (in `libs/decimal-scalar` or its own lib) for hash computation.

### 3.9 HcmAdapterModule

- Defines `HcmPort` interface.
- Ships one concrete adapter — `MockHcmAdapter` (HTTP-backed, points at the Mock HCM service).
- Wraps every call with circuit-breaker + timeout.
- Validates every response against the contract (transaction confirmation).
- Reports outcomes to `HcmHealthMonitor` (each successful call → healthy heartbeat; each failure of categorized type → failure observation).

**Key files:**
- `hcm/hcm.port.ts` — interface.
- `hcm/hcm-response.schema.ts` — zod schemas.
- `hcm/hcm-response.validator.ts` — strict validation logic (TRD §13.2).
- `hcm/adapters/mock-hcm.adapter.ts`.
- `hcm/circuit-breaker.ts`.

### 3.10 HcmHealthModule (NEW)

- Tracks HCM reachability with hysteresis.
- Becomes UNHEALTHY after `unhealthyAfterFailures` consecutive failures.
- Becomes HEALTHY after `healthyAfterSuccesses` consecutive successes spanning `healthRecoveryWindowMs`.
- Exposes `isHealthy()`, `outageStartedAt()`, `outageDuration()`.
- Emits domain events when state changes (consumed by ProvisionalReconciler).

**Key services:**
- `HcmHealthMonitor`.
- `HcmHealthRepository` (persists transitions for audit).

### 3.11 OutboxModule

- Schema for `outbox` table.
- `OutboxRepository` for atomic claim/process/ack.
- `OutboxService.enqueue(type, payload, idempotencyKey)` from domain code.
- Atomic enqueue: every domain transaction that needs a side effect inserts into outbox in the same transaction.

### 3.12 InboxModule

- Schema for `inbox_events` table.
- HTTP endpoint receives webhooks, validates signature with `crypto.timingSafeEqual`, inserts to table, returns 2xx.
- Dedupe by `eventId`.

### 3.13 OutboxWorkerModule

- `@Injectable()` background worker.
- `tick()` method: claim batch, process, ack. Public for test triggering.
- Polling loop registered via `@Cron` or `setInterval`.
- Calls HcmAdapterModule per entry type.
- Schedules deferred point-reads with jitter and coalescing (TRD §10.4).

### 3.14 InboxProcessorModule

- `@Injectable()` background worker.
- `tick()` method: claim batch, apply by event type, ack.
- Routes events to BalanceModule, EmploymentModule, LeaveTypeAvailabilityModule, EmployeeBootstrapModule.
- Triggers downstream effects: NEEDS_REVALIDATION cascades.

### 3.15 ReconciliationModule

- Four independent jobs:
  - `PointReadScheduler` — schedules deferred reads with jitter; coalesces per-balance.
  - `DriftSweep` — periodic.
  - `BatchReconciliation` — daily.
  - `ProvisionalReconciler` — drains `ProvisionalAction` rows when HCM is healthy. **Formalized in Rev 3** per Q.γ.
- Each is independently testable; each is independently configurable.

#### 3.15.1 ProvisionalReconciler algorithm (Rev 3, Q.γ)

The reconciler is the keystone of the system's exactly-once claim. Its algorithm is specified in detail in TRD §9.5.3. Code-organization implications:

**Files:**
- `reconciliation/provisional/provisional-reconciler.service.ts` — orchestrator.
- `reconciliation/provisional/pair-coalescer.ts` — pair-coalescing pass logic.
- `reconciliation/provisional/step-recorder.ts` — wraps `ReconciliationStepService.append` with type-safe step constructors.
- `reconciliation/provisional/advisory-lock.ts` — `ReconcilerLeaseRepository` wrapper exposing `tryAcquire()` and `release()` (Rev 3.1, Q.ι).
- `reconciliation/provisional/outcome-applier.ts` — applies the HCM response atomically with the step log entry.
- `reconciliation/provisional/snapshot-summarizer.ts` — produces `localStateSnapshotSummary` from the full `localStateSnapshot` (Rev 3.1, Q.θ).
- `reconciliation/provisional/employee-deletion-handler.ts` — handles the EMPLOYEE_NOT_FOUND branch (Rev 3.1, Q.ν).
- `reconciliation/provisional/stale-alerter.ts` — emits both audit event and metric gauge for stale actions (Rev 3.1, Q.λ).

**Subscriptions (event-driven):**
- Subscribes to `HCM_RECOVERED` events from `HcmHealthMonitor`.
- Also runs on a timer (`reconciler.provisionalIntervalMs`) while pending actions exist.

**Inputs from other modules:**
- `ProvisionalActionService.listPending()`.
- `ReconciliationStepService.findLastForAction(actionId)` — for resume decisions.
- `HcmPort.queryTransactions(filter)` — for pre-flight history query, using `reconciler.historyQueryWindowMs` window (Rev 3.1, Q.κ).
- `HcmPort.reserveBalance / releaseBalance` — for the actual call (when needed).
- `ReconcilerLeaseRepository.tryAcquire / release` — for mutual exclusion (Rev 3.1, Q.ι).
- `MetricsAdapter.gauge(name, value, tags)` — for stale-action gauge updates (Rev 3.1, Q.λ).

**Writes to:**
- `ReconciliationStepService.append(step)` — every step.
- `ProvisionalActionService.markReconciled(id, outcome, details, summary, nullifySnapshot)` — terminal transition with snapshot retention decision (Rev 3.1, Q.θ).
- `RequestService.escalateToHr(id, reason)` or symmetric — when applicable.
- `BalanceService.applyHoldsAfterReconciliation(...)` — atomic with the action row update.
- `AuditService.log(event)` — for each significant transition; `PROVISIONAL_ACTION_STALE` events for stale actions (Rev 3.1, Q.λ).

**Tests:**
- Layer 21 covers the algorithm specifically (T-PR-EX-01 through T-PR-EX-24 + property-based T-PR-PROP-*).
- Layer 23 covers the pair-coalescing pass specifically.
- Layer 8 (contract) covers the `queryTransactions` port method.
- Layer 16 (crash recovery) covers crashes between each step.

### 3.16 AuditModule

- `AuditService.log(event)`.
- Append-only `audit_events` table.
- Correlation-ID propagation via async-local-storage (AsyncLocalStorage from `node:async_hooks`).

### 3.17 ConfigModule

- Typed config object loaded from env + defaults.
- Validation at startup (zod); bad config fails fast.
- Tests inject overrides per-case.

### 3.18 AuthModule (boundary)

- `GatewayHeaderGuard` reads `x-tenant-id`, `x-actor-id`, `x-actor-role`.
- `RoleGuard` enforces role requirements per mutation (e.g., `break_glass_approver` for `approveTimeOffRequestProvisionally`, `hr_admin` for `hrReviewQueue`).
- Rejects self-approval at the boundary.
- All checks tested explicitly (see Test Plan layer 2, 18, 22).

---

## 4. Mock HCM module hierarchy

Separate Nest app:

```
MockHcmModule
├── MockHcmController              # Public HCM API (balance fetch, reserve, release, etc.)
├── AdminController                # Test-driving admin API
├── WebhookEmitter                 # Outbound webhook firing (configurable delay/drop/dup)
├── BalanceStore                   # Mock state (in SQLite, durable)
├── EmploymentStore
├── LeaveTypeAvailabilityStore
├── EmployeeStore
├── TransactionStore               # For idempotency-on-retry semantics
├── ModeManager                    # Adversarial mode controller (nine modes)
└── Scheduler                      # Anniversary, refresh, scheduled events
```

**Persistence (Revision 2).** Own SQLite database, separate file. This enables deterministic crash-recovery tests: after killing and restarting the service, the mock's state is the ground truth against which we assert. Earlier design (pure in-memory) made "did the mock apply the change?" answerable only by side channels.

**Why a separate SQLite, not the service's:** total isolation. The mock should not be inspectable as a shortcut by the service's code — it must look like a remote system.

**Adversarial modes** (mode-controlled via admin endpoint, per TRD §17): `normal`, `flaky`, `silent_no_op`, `wrong_delta`, `missing_confirmation`, `stale_version`, `malformed`, `slow`, `version_skew`.

---

## 5. Critical interfaces

### 5.1 HcmPort

```typescript
interface HcmPort {
  fetchBalance(args: FetchBalanceArgs): Promise<HcmFetchResponse>;
  reserveBalance(args: ReserveBalanceArgs, idempotencyKey: string): Promise<HcmMutationResponse>;
  releaseBalance(args: ReleaseBalanceArgs, idempotencyKey: string): Promise<HcmMutationResponse>;
  fetchEmployment(employeeId: string): Promise<HcmEmploymentResponse>;
  fetchLeaveTypes(locationId: string): Promise<HcmLeaveTypesResponse>;
  fetchEmployee(employeeId: string): Promise<HcmEmployeeResponse>;     // for lazy pull
  fetchBatch(cursor?: string): AsyncIterable<HcmBatchEntry>;
}

interface HcmMutationResponse {
  transactionId: string;       // unique
  deltaApplied: Decimal;       // actual change applied; SOUND check, not arithmetic
  newAvailable: Decimal;       // balance after apply
  hcmVersion: bigint;          // monotonic, ORDERING AUTHORITY
  appliedAt: ISOTimestamp;     // INFORMATIONAL ONLY
}
```

Required: every mutation response carries the full transaction confirmation (TRD §13.2, ADR-005).

### 5.2 RequestService

```typescript
interface RequestService {
  create(input, ctx, idempotencyKey): Promise<TimeOffRequestPayload>;
  approve(id, approverId, ctx, idempotencyKey): Promise<TimeOffRequestPayload>;
  approveProvisionally(id, approverId, justification, ctx, idempotencyKey): Promise<TimeOffRequestPayload>;
  reject(id, approverId, reason, ctx, idempotencyKey): Promise<TimeOffRequestPayload>;
  cancel(id, actorId, ctx, idempotencyKey): Promise<TimeOffRequestPayload>;
  revalidate(id, reason): Promise<void>;     // internal — triggered by events
  escalateToHr(id, escalationReason, provisionalActionId): Promise<void>;     // internal
}
```

### 5.3 BalanceService

```typescript
interface BalanceService {
  get(emp, loc, type): Promise<Balance>;
  list(emp): Promise<Balance[]>;
  applyHcmUpdate(event): Promise<void>;     // from inbox
  applyHold(emp, loc, type, units, kind: 'pending'|'approved'|'provisional'): Promise<void>;
  releaseHold(emp, loc, type, units, kind): Promise<void>;
  promoteHold(emp, loc, type, units, from: HoldKind, to: HoldKind): Promise<void>;
}
```

### 5.4 EmploymentService

```typescript
interface EmploymentService {
  locationAt(employeeId, date): Promise<string | null>;
  history(employeeId): Promise<EmploymentPeriod[]>;
  applyHcmUpdate(event): Promise<void>;
}
```

### 5.5 HcmHealthMonitor (NEW)

```typescript
interface HcmHealthMonitor {
  recordSuccess(): void;
  recordFailure(category: 'transient' | 'permanent'): void;
  isHealthy(): boolean;
  outageStartedAt(): Date | null;
  outageDuration(): number;     // ms; 0 if healthy
  onStateChange(listener: (state: 'HEALTHY' | 'UNHEALTHY') => void): Unsubscribe;
}
```

Hysteresis prevents flapping. Configurable thresholds in `ServiceConfig.hcmHealth`.

### 5.6 BreakGlassAuthorizer (NEW)

```typescript
interface BreakGlassAuthorizer {
  /**
   * Returns Ok or a typed denial reason:
   *  - 'NOT_AUTHORIZED' — caller lacks break_glass_approver role
   *  - 'OUTAGE_THRESHOLD_NOT_MET' — HCM hasn't been down long enough
   *  - 'HCM_HEALTHY' — HCM is reachable; use normal approval path
   */
  authorize(actorContext: ActorContext): AuthorizationResult;
}
```

### 5.7 ProvisionalReconciler (Rev 3 formalized, Q.γ)

```typescript
/**
 * Drains pending ProvisionalAction rows when HCM is reachable.
 *
 * Algorithm (TRD §9.5.3):
 *   1. Acquire advisory lock (single-row); skip tick if held.
 *   2. Pair-coalescing pass: opposing actions on same request → both NO_OP.
 *   3. For each remaining pending action:
 *      a. Check last ReconciliationStep — resume or skip if terminal.
 *      b. Pre-flight HCM transaction-history query (idempotency key = action.id).
 *      c. Skip or call HCM based on history.
 *      d. Apply outcome atomically with terminal ReconciliationStep.
 *
 * Guarantees: exactly-once HCM mutation per ProvisionalAction. Every step
 * recorded in ReconciliationStep. Audit chain reproducible from log alone.
 */
interface ProvisionalReconciler {
  /** Drain pending ProvisionalAction rows. Triggered by HCM_RECOVERED or timer. */
  drain(): Promise<DrainResult>;

  /** Reconcile a single ProvisionalAction. Idempotent across crashes. */
  reconcileOne(actionId: string): Promise<ReconciliationOutcome>;
}

interface DrainResult {
  skipped?: boolean;             // true if lock unavailable
  skippedReason?: string;
  coalescedCount: number;        // pair-coalesced actions
  reconciledCount: number;       // individually reconciled actions
  outcomes: { confirmed: number; escalated: number; noOp: number; deferred: number };
}

type ReconciliationOutcome =
  | { kind: 'CONFIRMED'; hcmTransactionId: string; stepIds: string[] }
  | { kind: 'REJECTED_ESCALATED'; reason: ErrorCode; stepIds: string[] }
  | { kind: 'NO_OP'; reason: 'PAIR_COALESCED' | 'NO_HCM_DEBIT_FOUND' | 'ALREADY_RECONCILED'; stepIds: string[] }
  | { kind: 'DEFERRED'; reason: 'HCM_TRANSIENT' | 'LOCK_UNAVAILABLE'; willRetry: boolean };
```

The `stepIds` field on each outcome makes the audit chain explicit at the API surface — every outcome refers to the specific steps that produced it.

### 5.8 EmployeeBootstrapService (NEW)

```typescript
interface EmployeeBootstrapService {
  /** Idempotent. Tries webhook-projected state, falls back to HCM lazy pull. */
  ensureBootstrapped(employeeId: string): Promise<Employee>;

  /** Called by InboxProcessor when EMPLOYEE_CREATED arrives. */
  handleEmployeeCreatedEvent(event: HcmEmployeeCreatedEvent): Promise<void>;

  /** Called by BatchReconciliation for previously-unknown employees. */
  bootstrapFromBatch(row: HcmBatchEmployeeRow): Promise<void>;
}
```

### 5.9 CanonicalInputSerializer (Rev 2)

```typescript
interface CanonicalInputSerializer {
  /**
   * Canonicalize input for idempotency hashing. Rules:
   *  - Dates: parsed to ISO-8601 (YYYY-MM-DD if no time), reserialized.
   *  - Decimals: parsed to Decimal with leave-type precision, reserialized with trailing zeros stripped.
   *  - JSON: sorted keys recursively.
   *  - Strings: NFC normalization.
   *  - Null/undefined: treated identically (omitted from canonical form).
   * @returns canonical UTF-8 bytes suitable for hashing.
   */
  canonicalize(input: object): Buffer;

  /** SHA-256 over canonicalize(input). */
  hash(input: object): string;
}
```

### 5.10 ReconciliationStepService (NEW in Rev 3, Q.γ + Q.δ)

```typescript
/**
 * Strictly append-only event log for the provisional reconciler.
 * Every step the reconciler takes produces exactly one row.
 *
 * The reconciler reads `findLastForAction()` to determine where to resume
 * after a crash. The HR Review surface reads `findAllForAction()` for the
 * full audit chain.
 *
 * INVARIANT: no row is ever updated. No row is ever deleted.
 *            Enforced at repository (single `insert` method).
 *            Optionally also enforced via SQLite trigger.
 */
interface ReconciliationStepService {
  /** The only write operation. Returns the inserted row with assigned id. */
  append(input: ReconciliationStepInput): Promise<ReconciliationStep>;

  /** Used by reconciler for resume decisions on restart. */
  findLastForAction(actionId: string): Promise<ReconciliationStep | null>;

  /** Used by HR Review and audit-chain queries. */
  findAllForAction(actionId: string): Promise<ReconciliationStep[]>;
}

interface ReconciliationStepInput {
  actionId: string;
  kind: ReconciliationStepKind;
  outcome: 'PARTIAL' | 'TERMINAL';
  payload: object;            // serialized step inputs/outputs for replayability
  workerId: string;           // who wrote this row (for concurrent debugging)
}
```

### 5.11 HrReviewQueueService (NEW in Rev 3, Q.β)

```typescript
/**
 * Read-side query layer for HR-facing surface of requests needing attention.
 *
 * Categories:
 *  - ESCALATED_PRE_LEAVE: state == ESCALATED_TO_HR (HCM rejected provisional
 *    approval before leave date)
 *  - ESCALATED_POST_LEAVE: state == TAKEN AND hrReviewFlag == true
 *    (HCM rejected provisional approval after leave was taken)
 *  - CANCELLATION_STUCK: state == CANCELLATION_PENDING with age >
 *    cancellationPendingAlertThresholdMs
 *
 * Backed by RequestRepository, ProvisionalActionRepository,
 * and ReconciliationStepRepository. Stateless; no write paths.
 */
interface HrReviewQueueService {
  list(filter: HrReviewFilter): Promise<HrReviewItem[]>;
}

interface HrReviewFilter {
  categories?: HrReviewCategory[];     // omit = all
  employeeId?: string;
  locationId?: string;
}

interface HrReviewItem {
  request: TimeOffRequest;
  category: HrReviewCategory;
  flaggedAt: Date;
  reason: string;
  provisionalActions: ProvisionalAction[];          // with embedded reconciliationSteps
}
```

### 5.12 MockHcmTestHarness file location (NEW in Rev 3, Q.ε; extended Rev 3.1, Q.ν)

The harness is testing infrastructure, not production code. Location:

```
apps/service/test/helpers/mock-hcm-test-harness.ts          # The class
apps/service/test/helpers/mock-hcm-test-harness.spec.ts     # Self-tests (Layer 24)
apps/service/test/helpers/mock-hcm-test-harness.types.ts    # Type exports
```

Imported as `import { MockHcmTestHarness } from '@test/helpers/mock-hcm-test-harness'` from every test file that touches the mock. Full interface specified in `01_TRD.md §17.6`.

**Code-level conventions:**
- Every public method has a TSDoc block with a TRD §17 reference.
- Lifecycle methods (`reset`, `shutdown`, `snapshot`, `restoreSnapshot`) are documented as "lifecycle".
- Seeding methods are documented with their idempotency semantics.
- Assertion methods throw `MockHcmHarnessAssertionError` (not generic `Error`) for clean test failure messages.
- The harness is the ONLY way tests touch mock admin endpoints; a lint rule (or convention) forbids ad-hoc `http.post('/admin/...')` calls outside the harness file.

**Rev 3.1 addition (Q.ν).** New helper method `deleteEmployee(employeeId)` for testing the EMPLOYEE_NOT_FOUND_AT_HCM branch in the reconciler (T-PR-EX-12, T-PR-EX-13). The mock's underlying `EmployeeStore.delete()` is exposed via admin endpoint and wrapped in the harness for a clean test API.

### 5.13 ReconcilerLeaseRepository (NEW in Rev 3.1, Q.ι)

```typescript
/**
 * Single-row advisory lock for the provisional reconciler.
 *
 * The lease has a TTL so that crashed workers don't block reconciliation
 * indefinitely. Acquisition is a single atomic UPDATE statement that
 * conditionally claims the lock if it is unheld OR expired.
 *
 * Release is conditioned on heldBy = ? to prevent a confused worker
 * from releasing someone else's lease after a TTL-expiration handoff.
 *
 * @ref TRD §5.9
 */
interface ReconcilerLeaseRepository {
  /**
   * Attempt to acquire the lease. Returns the lease record if acquired,
   * null if held by another worker.
   *
   * The leaseTtlMs is added to now() to compute expiresAt.
   */
  tryAcquire(leaseId: string, workerId: string, leaseTtlMs: number): Promise<ReconcilerLease | null>;

  /**
   * Release the lease. No-op if the caller is not the holder
   * (e.g., the lease was already reclaimed via TTL expiration).
   */
  release(leaseId: string, workerId: string): Promise<void>;

  /**
   * Inspect the current lease state. For debugging and tests.
   */
  inspect(leaseId: string): Promise<ReconcilerLease>;
}

interface ReconcilerLease {
  id: string;                  // 'provisional'
  heldBy: string | null;       // workerId or null when free
  acquiredAt: Date | null;
  expiresAt: Date | null;
}
```

The corresponding service wrapper `AdvisoryLock` (in `reconciliation/provisional/advisory-lock.ts`) handles the TTL math and provides a clean callsite for the reconciler.

### 5.14 MetricsAdapter (NEW in Rev 3.1, Q.λ)

```typescript
/**
 * Minimal metrics adapter interface. The service emits metrics through
 * this interface only — never through direct Prometheus or other client
 * libraries. Production wires a concrete adapter; tests use a recording
 * adapter that captures emitted metrics for assertions.
 *
 * @ref TRD §9.5.6, §19.3
 */
interface MetricsAdapter {
  /** Emit a counter increment. Counters never decrease. */
  counter(name: string, value?: number, tags?: Record<string, string>): void;

  /**
   * Set a gauge value. Gauges represent current state (e.g., count of
   * stale provisional actions, current outbox queue depth).
   *
   * Sampled by external systems (Prometheus scrape, etc.). Persisting
   * the value is the adapter's concern.
   */
  gauge(name: string, value: number, tags?: Record<string, string>): void;

  /** Record an observation in a histogram (latency, sizes, etc.). */
  histogram(name: string, value: number, tags?: Record<string, string>): void;
}
```

**Default implementation:** `NoopMetricsAdapter` (no-op). Production wires Prometheus, StatsD, or equivalent. Tests inject `RecordingMetricsAdapter` that captures emitted metrics for inspection.

**Why an interface, not direct Prometheus.** Decoupling lets us swap the implementation without touching call sites; lets tests assert on emitted metrics without running Prometheus; lets the default deployment have zero metrics infrastructure (development environments).

---

## 6. Documentation conventions inside the codebase

Every module has a `README.md` summarizing:

- **Purpose** (one paragraph).
- **Public interface** (links to service interface files).
- **Invariants** the module maintains.
- **Where it appears in the saga** (with TRD §9.x reference).
- **Event interactions** (what it produces, what it consumes — important for the event-driven parts).
- **Tests that cover it** (link to test files).

Every public method has a TSDoc comment:

- Description.
- `@throws` for documented errors.
- `@invariant` (custom tag) for invariants this method maintains.
- `@ref` to TRD section.
- `@event` tags for methods that produce or consume domain events.

**Illustrative comment (not actual code, for guidance):**

```
/**
 * Approves a pending time-off request. Calls HCM live; HCM is dispositive.
 *
 * @invariant On HCM success: balance.available reflects HCM's newAvailable;
 *            request.state == APPROVED; hcmTransactionId set.
 * @invariant On HCM rejection: pendingHold released; request.state == REJECTED.
 * @invariant On HCM unavailable: fails closed; request remains PENDING_APPROVAL;
 *            caller may invoke approveProvisionally() with break-glass role.
 * @throws DomainError(STATE_TRANSITION_NOT_ALLOWED) if request is not PENDING_APPROVAL.
 * @throws DomainError(HCM_UNAVAILABLE) if HCM cannot be reached.
 * @throws DomainError(INSUFFICIENT_BALANCE_HCM) if HCM rejects.
 * @event Emits AuditEvent('request_approved') on success.
 * @ref TRD §9.2
 */
```

**Why this convention.** The agentic developer needs unambiguous contracts at the method boundary. Inline links to TRD sections keep the code and the spec aligned during change.

---

## 7. Test file organization

```
test/
├── unit/                                 # Mirrors src/ structure
├── integration/                          # By module
├── e2e/                                  # Scenario-based
├── property/                             # By invariant
├── failure-injection/                    # By mock mode
├── inbound-adversarial/                  # By attack class
├── reconciliation/                       # By cadence
├── contract/                             # By adapter
├── crash-recovery/                       # By saga step
├── mock-hcm-internal/                    # NEW: tests for the mock itself
├── break-glass/                          # NEW: provisional flow tests
├── bootstrap/                            # NEW: bootstrap paths
├── fixtures/
└── helpers/
```

**Naming convention:** `<scenario>.<expected-behavior>.spec.ts`.

**Test ID convention:** `T-<LAYER>-<NUM>` (e.g., `T-PROP-01`, `T-FI-NOOP-01`, `T-BG-01`, `T-BOOT-01`). IDs are stable across refactors; the TRD edge case list and Test Plan traceability matrix reference them.

---

## 8. Worker discipline

### 8.1 Outbox worker

```
async tick(): Promise<void> {
  const claimed = await this.repo.claimBatch(this.config.batchSize);
  for (const entry of claimed) {
    try {
      const result = await this.processOne(entry);
      await this.repo.markSucceeded(entry.id, result);
      if (entry.type === 'RESERVE_BALANCE' || entry.type === 'RELEASE_BALANCE') {
        this.pointReadScheduler.schedule({
          balanceKey: entry.balanceKey,
          atDelay: this.config.pointReadDelayMs + this.jitter(),
        });
      }
    } catch (err) {
      await this.handleError(entry, err);
    }
  }
}

async processOne(entry: OutboxEntry): Promise<HcmMutationResponse> {
  const adapter = this.hcmPort;
  switch (entry.type) {
    case 'RESERVE_BALANCE':       return adapter.reserveBalance(entry.payload, entry.idempotencyKey);
    case 'RELEASE_BALANCE':       return adapter.releaseBalance(entry.payload, entry.idempotencyKey);
    case 'FETCH_BALANCE':         return adapter.fetchBalance(entry.payload);
    case 'BOOTSTRAP_EMPLOYEE':    return this.bootstrap.handle(entry.payload);
    case 'RECONCILE_PROVISIONAL': return this.provisionalReconciler.reconcileOne(entry.payload.actionId);
  }
}
```

Claim is atomic via `BEGIN IMMEDIATE` + `UPDATE outbox SET state='IN_FLIGHT' WHERE state='PENDING' ORDER BY next_attempt_at LIMIT ? RETURNING *`.

### 8.2 Provisional reconciler (Rev 3 formalized, Q.γ)

The reconciler does its own orchestration rather than delegating to the outbox worker. Reason: each step depends on the previous step's outcome (e.g., the pre-flight history query result determines whether to call HCM), so the outbox's stateless retry model doesn't fit. The reconciler's own state lives in the `ReconciliationStep` log.

```
async drain(): Promise<DrainResult> {
  if (!this.health.isHealthy()) return { skipped: true, skippedReason: 'HCM not healthy', ... };

  // [0] Single-row advisory lock (concurrent tick exclusion).
  const lease = await this.lock.tryAcquire('provisional-reconciler');
  if (!lease) return { skipped: true, skippedReason: 'lock unavailable', ... };

  try {
    // [1] Pair-coalescing pass — opposing actions on same request.
    const coalesced = await this.pairCoalescer.coalescePending();

    // [2] Drain remaining pending actions.
    const pending = await this.provisionalActions.listPending(this.config.batchSize);
    const outcomes = { confirmed: 0, escalated: 0, noOp: 0, deferred: 0 };
    for (const action of pending) {
      const outcome = await this.reconcileOne(action.id);
      outcomes[outcome.kind === 'CONFIRMED' ? 'confirmed'
              : outcome.kind === 'REJECTED_ESCALATED' ? 'escalated'
              : outcome.kind === 'NO_OP' ? 'noOp'
              : 'deferred']++;
    }

    return { coalescedCount: coalesced.length, reconciledCount: pending.length, outcomes };
  } finally {
    await this.lock.release(lease);
  }
}

async reconcileOne(actionId: string): Promise<ReconciliationOutcome> {
  // [3.0] Crash-recovery guard: load last step.
  const lastStep = await this.steps.findLastForAction(actionId);
  if (lastStep?.outcome === 'TERMINAL') {
    return { kind: 'NO_OP', reason: 'ALREADY_RECONCILED', stepIds: [lastStep.id] };
  }

  // [3.1] Pre-flight history query.
  const historyResult = await this.preFlightHistoryQuery(actionId);
  if (historyResult.kind === 'TRANSIENT_FAILURE') {
    return { kind: 'DEFERRED', reason: 'HCM_TRANSIENT', willRetry: true };
  }

  // [3.2] Decide based on history.
  if (historyResult.kind === 'EXISTING_MATCH') {
    return await this.applyOutcomeFromExistingTransaction(actionId, historyResult.transaction);
  }
  if (historyResult.kind === 'MISMATCH') {
    return await this.applyOutcomeMismatch(actionId, historyResult);
  }

  // [3.3] Call HCM (history shows no transaction).
  return await this.callHcmAndApply(actionId);
}
```

The `reconcileOne` method is structured around the algorithm's branches; every branch ends in either a terminal `ReconciliationStep` row (CONFIRMED, REJECTED_ESCALATED, NO_OP) or leaves the action `PENDING` for retry (DEFERRED). The outbox is not used for the reconciler's HCM calls — the reconciler's own step log is the durability layer.

### 8.3 Point-read scheduler with coalescing

```
schedule({ balanceKey, atDelay }) {
  const existing = this.pending.get(balanceKey);
  if (existing && existing.firesAt <= now() + atDelay) return; // already scheduled sooner
  this.pending.set(balanceKey, { firesAt: now() + atDelay });
}

async tick() {
  const due = [...this.pending].filter(([_, v]) => v.firesAt <= now());
  for (const [balanceKey] of due) {
    this.pending.delete(balanceKey);
    await this.outbox.enqueue({ type: 'FETCH_BALANCE', payload: { balanceKey }, ... });
  }
}
```

Per-balance coalescing prevents the thundering-herd scenario (TRD §10.4).

---

## 9. Decimal handling conventions

`decimal.js` `Decimal` is the only numeric type for units, balances, holds, and deltas. Cross-cutting rules:

- **Database (SQLite):** Decimals stored as `TEXT` columns containing canonical string form (no trailing zeros except for required precision). TypeORM column transformer parses on read, serializes on write.
- **GraphQL:** `Decimal` is a custom scalar serialized as string. Both input and output go through canonical form.
- **HCM contract:** zod schema validates HCM responses parse `deltaApplied`, `newAvailable`, etc., from strings into `Decimal`. Numeric responses from HCM are still parsed defensively.
- **Equality:** never use `===`; always `a.equals(b)`.
- **Comparison:** `Decimal.cmp` returns -1/0/1; usage is wrapped in helpers (`lt`, `lte`, `gt`, `gte`, `eq`).
- **Rounding:** all rounding happens at the boundary (input parse, output serialize). Internal arithmetic preserves full precision.
- **Leave-type precision:** when comparing or storing for a specific leave type, round to that type's declared precision (default half-day = 0.5 step).

**Why decimal.js:** native JS `number` is binary float and silently wrong for monetary/quantity arithmetic. `0.1 + 0.2 !== 0.3` is unacceptable for balance accounting. `decimal.js` is mature, widely used, and has the API ergonomics we want.

**Why not BigInt with implicit scaling:** workable, but every arithmetic site has to remember the scale factor. `Decimal` puts the precision concern in the type, not in every call site.

---

## 10. Error handling & logging conventions

### Errors

- Domain errors are typed (`DomainError` class hierarchy).
- They carry `ErrorCode`, message, optional field, retryable flag, correlationId.
- Resolvers map them to GraphQL payload errors via a single `ErrorMapper`.
- Worker errors are caught at `tick()` boundary and routed to `handleError`.
- HCM port errors are categorized: `HcmTransientError`, `HcmPermanentError`, `HcmContractViolation`. Each routes differently in the worker.
- Audit events log every error with full context.

### Logging

- Structured logs only (JSON).
- Every log line includes `correlationId`, `tenantId`, `actorId`.
- Log levels: `debug` for dev, `info` for state transitions, `warn` for retryable failures, `error` for unexpected.
- Counters: requests by state, outbox entries by state, HCM calls by adapter+result, reconciliation runs by outcome, provisional actions by state, bootstrap attempts by source.
- Histograms: HCM call duration, outbox dispatch latency, reconciliation duration, time-to-reconcile-provisional.
- All hooks are no-ops by default; production wires real exporters (TRD §19.3).

---

## 11. Build, deployment, and README requirements

### Build

- Single `Dockerfile` per app (service, mock-hcm).
- `docker-compose.yml` brings up both for local dev and E2E tests.
- Migrations run on startup *and* as a separate command for prod parity.
- Healthcheck endpoint required: `GET /health` returns SQLite ping + worker liveness + HCM reachability.
- Graceful shutdown: drain in-flight HCM calls, finish current outbox tick, close DB. SIGTERM handler with configurable drain timeout.

### Mock HCM persistence

- Mock HCM uses its own SQLite file (separate from service). Default location `apps/mock-hcm/data/mock-hcm.sqlite`.
- Mock state is durable across mock restarts — required for crash-recovery tests where the service crashes after HCM has applied a change.
- Admin endpoint `POST /admin/reset` clears the mock's DB for test isolation.

### Root README requirements

- One-paragraph overview.
- Quickstart (clone, install, migrate, run, test).
- Architecture diagram (Mermaid, embedded).
- Pointers to all five documentation files (00, 01, 02, 03, 04).
- How to run each test layer.
- How to interpret coverage and mutation reports.
- Pointers to operational runbooks:
  - `docs/operations/break-glass-runbook.md` — when to invoke, who can, how to review afterward.
  - `docs/operations/bootstrap-runbook.md` — diagnosing employees who fail to appear.
  - `docs/operations/reconciliation-runbook.md` — interpreting drift classifications.
  - `docs/operations/provisional-reconciler-runbook.md` (Rev 3) — interpreting `ReconciliationStep` logs, debugging stuck provisional actions, manual replay procedures, `provisionalActionStaleAlertMs` triggers.
  - `docs/operations/hr-review-runbook.md` (Rev 3) — workflow for HR users consuming `hrReviewQueue`, how to resolve each category, audit-chain interpretation.
- Known limitations (linking to §19 and §21 of TRD).

Each app's `README.md` covers app-specific run/build instructions.
