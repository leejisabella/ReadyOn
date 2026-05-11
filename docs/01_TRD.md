# Time-Off Microservice — Technical Requirements Document (TRD)

**Status:** Revision 3.1
**Owner:** ReadyOn Platform — Time & Attendance
**Stack:** NestJS (TypeScript), SQLite, GraphQL, `decimal.js`
**Companion docs:** `00_Cover_and_Reasoning.md`, `02_Assumptions_and_Decisions.md`, `03_Test_Plan.md`, `04_Module_Plan.md`

---

## CHANGELOG (since Revision 3)

Rev 3.1 is a focused patch closing six open questions from the Rev 3 review. No new architectural pieces; refinements to existing ones.

- **§5.6 (UPDATED, Q.θ):** `ProvisionalAction.localStateSnapshot` retention policy specified: full snapshot stored on insert; on successful reconciliation, summarized to a compact form; full snapshot retained indefinitely for ESCALATED outcomes (the only ones HR will investigate).
- **§5.9 (NEW, Q.ι):** New `ReconcilerLease` table — single-row advisory lock backing the provisional reconciler's mutual exclusion. Row-based for debuggability over implicit `BEGIN EXCLUSIVE`.
- **§5.7 (UPDATED, Q.ν):** New `ReconciliationStep.kind` value `EMPLOYEE_NOT_FOUND_AT_HCM` for the edge case where an employee's HCM record was deleted between break-glass invocation and reconciliation.
- **§9.5.3 (UPDATED, Q.κ, Q.ν):** Pre-flight history-query window is now explicit at 24 hours (configurable). New branch handles HCM returning `EMPLOYEE_NOT_FOUND` during reconciliation — transitions to `REJECTED_ESCALATED` with `hrReviewReason = "Employee no longer in HCM"`.
- **§9.5.6 (NEW, Q.λ):** Stale-provisional-action alerting integration — emits both an audit event AND a metric counter for ops dashboards.
- **§7.1 (UPDATED, Q.μ):** `hrReviewQueue` now supports cursor pagination (`first`, `after`). New `HrReviewItemConnection` type matching the rest of the GraphQL surface.
- **§14.6 (UPDATED, Q.ν):** New error code `EMPLOYEE_NOT_FOUND_AT_HCM_DURING_RECONCILIATION`.
- **§15 (UPDATED):** Edge case 79 added: employee deleted at HCM between break-glass and reconciliation. Edge case 80: history-query window exclusion (transaction outside the configured window).
- **§16 (UPDATED):** New configuration knobs: `reconciler.historyQueryWindowMs` (default 86400000 = 24h), `reconciler.leaseTtlMs` (default 60000), `reconciler.snapshotRetention.summarizeAfterSuccess` (default `true`), `reconciler.staleAlertMetricName` (default `provisional_action_stale_count`).

## CHANGELOG (since Revision 2)

- **§9.4 (UPDATED, Q.α):** Provisional cancellation now requires the client to attach an explicit `acknowledgedHcmUnavailable: true` field to the mutation, so the UI has a clear contract for surfacing the warning. Server-side rejects without it during outage. Asymmetry preserved (no role gate for cancellation).
- **§9.5.3 (UPDATED, Q.γ):** Provisional reconciler algorithm fully formalized. Pre-flight HCM transaction-history query precedes any reserve/release; idempotency key is the ProvisionalAction.id; every step is event-logged in `ReconciliationStep` (new table); every step is verified to be executed exactly once and matched in both ReadyOn and HCM.
- **§5.7 (NEW, Q.γ):** New table `ReconciliationStep` — append-only per-step event log for the provisional reconciler.
- **§5.8 (NEW, Q.δ):** Documented append-only convention for `ProvisionalAction` and `ReconciliationStep` with repository-enforced field-allow-list for limited updates. Triggers as a belt-and-suspenders option discussed.
- **§6.2 (UPDATED, Q.β):** `TAKEN` state on a previously `PROVISIONALLY_APPROVED` request now carries a `hrReviewFlag` and a `hrReviewReason`. These requests surface via a new HR review query.
- **§7.1 (UPDATED, Q.β):** New query `hrReviewQueue` returns the list of requests awaiting HR review (post-TAKEN unreconciled provisional, ESCALATED_TO_HR, others).
- **§9.5 (NEW, Q.ζ):** Provisional action pair-coalescing — opposing actions on the same request (e.g., provisional-approval followed by provisional-cancellation) are recognized as a pair and reconciled as `NO_OP` without making the HCM call. Documented as an optimization and a correctness mechanism.
- **§17 + §18 (UPDATED, Q.ε):** Mock HCM test harness specified — single class `MockHcmTestHarness` centralizes mock state reset, mode setting, seeding, and assertions for all test layers. Required by the test plan; documented as a deliverable.
- **§13.7 (NEW):** New error codes added for the formalized reconciler: `PROVISIONAL_RECONCILIATION_TRANSIENT_FAILURE`, `PROVISIONAL_RECONCILIATION_ALREADY_RECONCILED`, `HR_REVIEW_REQUIRED`, `CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT`.
- **§15 (UPDATED):** Edge case enumeration extended to 78 cases covering all Revision-3 flows.

## CHANGELOG (since Revision 1, preserved)

- **§6.2 + §9.5 + §13:** Added `PROVISIONALLY_APPROVED` and `ESCALATED_TO_HR` request states. Break-glass override for approvals during sustained HCM outage. Documented event-driven reconciliation of provisional actions.
- **§9.4:** Cancellation during HCM outage is provisional by default (asymmetric with approval). Added cancellation-pending alert threshold.
- **§10.4:** Point-read scheduling now includes jitter and per-balance coalescing to prevent thundering-herd against HCM.
- **§14.4:** Canonical input serializer specification for idempotency hashing — explicit rules for dates, decimals, JSON field order, Unicode normalization.
- **§17.4:** Mock HCM now uses its own SQLite store for durable state, enabling deterministic crash-recovery tests.
- **§5.5 + §11:** Employee bootstrap flow — webhook-driven primary path, pull-on-first-touch safety net. New `EmployeeBootstrapService`.
- **§10.1:** Explicit: `hcmVersion` is the ordering authority; `appliedAt` is informational only.
- **§14.5:** `decimal.js` chosen for all monetary/unit arithmetic, with serialization rules for GraphQL and SQLite.
- **§16:** `policy.advanceLeaveToleranceUnits` reclassified as UX hint, not enforcement.
- **§14.6:** Added `BREAK_GLASS_NOT_AUTHORIZED`, `BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET`, `PROVISIONAL_RECONCILIATION_REJECTED`, `EMPLOYEE_NOT_BOOTSTRAPPED` to error taxonomy.
- **§15:** Edge case enumeration extended to 67 cases covering Revision-2 flows.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Glossary](#3-glossary)
4. [Source-of-Truth Model](#4-source-of-truth-model)
5. [Domain Model](#5-domain-model)
6. [State Vocabulary (three-axis)](#6-state-vocabulary-three-axis)
7. [GraphQL API](#7-graphql-api)
8. [Architecture & Process Topology](#8-architecture--process-topology)
9. [Request Lifecycle (Saga)](#9-request-lifecycle-saga)
10. [Synchronization with HCM](#10-synchronization-with-hcm)
11. [Employee Bootstrap](#11-employee-bootstrap)
12. [Location Transfers (in scope)](#12-location-transfers)
13. [Defensive Strategy Against Unreported HCM Errors](#13-defensive-strategy)
14. [Error Taxonomy + Idempotency + Decimals](#14-error-taxonomy-idempotency-decimals)
15. [Edge Cases (enumerated)](#15-edge-cases)
16. [Configuration (tested as a concern)](#16-configuration)
17. [Mock HCM Server](#17-mock-hcm-server)
18. [Test Strategy (high-level)](#18-test-strategy-high-level)
19. [Out-of-Scope, Boundary-Defined](#19-out-of-scope-boundary-defined)
20. [Alternatives Considered](#20-alternatives-considered)
21. [Future Work](#21-future-work)

---

## 1. Overview

ReadyOn is the employee-facing module for time-off requests. The HCM system (Workday, SAP SuccessFactors, etc.) is the **source of truth** for balance and employment data. This service owns the lifecycle of a time-off request and maintains a local projection of HCM data sufficient to serve the UI, support defensible reconciliation, and allow continued operation under sustained HCM outage via an explicit break-glass mechanism.

Balances are scoped **per-employee, per-location, per-leave-type**. Employees can change locations; the system honors HCM's employment timeline.

### Design posture (revised)

Four principles drive every design choice:

1. **HCM is dispositive at every commit point that can reach it.** Live HCM verification at approval and cancellation. Local state is a projection — it accelerates UX and enables resilience but never overrides HCM.
2. **Defensive against silent failure.** HCM may not always report errors. Every mutation response is validated for a transaction confirmation. Reconciliation is a layered, configurable backstop.
3. **Operability under sustained HCM outage.** Approvals fail closed by default but a **break-glass override** allows authorized approvers to mark requests `PROVISIONALLY_APPROVED`. Every provisional decision is event-logged and reconciled when HCM is reachable again. Cancellations during outage are provisional by default (lower risk; credit operation).
4. **Event-driven reconciliation of provisional actions.** Provisional decisions emit explicit events. On HCM recovery, a dedicated reconciliation pass replays these events against HCM ground truth, producing one of three outcomes per event: confirmed (→ APPROVED), rejected (→ ESCALATED_TO_HR), or no-op (cancellation: → CANCELLED).

The break-glass mechanism exists because the cost of "no approvals during a multi-hour HCM outage" is unacceptable for a workforce-facing system. The audit-heavy reconciliation pass is the safety net that keeps HCM canonical.

## 2. Goals & Non-Goals

### Goals
- GraphQL API for querying balances, employment, and leave-type availability; for creating, approving, rejecting, cancelling requests; and (for authorized roles) invoking break-glass.
- Locally-maintained, eventually-consistent projection of HCM data.
- Live HCM consultation at every commit point that can reach HCM.
- Sustained operability via break-glass override + event-driven reconciliation.
- Strong defenses against HCM reporting success when nothing happened.
- Full handling of location transfers including pending-request revalidation.
- Employee bootstrap on webhook and on first-touch.
- Robust test suite that prevents regression on every guarantee.

### Non-goals
- UI work.
- Production-grade auth, multi-tenancy. Defined at the boundary, not implemented.
- Vendor-specific HCM connectors. Only a configurable mock; real adapters conform to the same port.
- Horizontal scale beyond a single writer (SQLite limitation, addressed in §21).
- Sub-day (hourly) leave. All units are days.
- Multi-step approval chains. Single-manager approval only.
- Cancellation of `TAKEN` leave. Terminal state, manual HR intervention.
- I18n of error messages — English-only for this exercise.

## 3. Glossary

- **HCM** — Human Capital Management system.
- **Balance** — Available units for `(employeeId, locationId, leaveTypeId)`.
- **Hold** — Local-only memory of an in-flight or unapproved unit allocation.
- **LeaveTypeAvailability** — Projection of which `(locationId, leaveTypeId)` pairs are valid.
- **Employment** — Projection of an employee's location timeline.
- **Outbox** — Durable queue of pending side effects to HCM.
- **Inbox** — Durable queue of inbound events from HCM (webhooks, batch).
- **Reconciler** — Job that converges local projection on HCM state.
- **Provisional Action Log** — Append-only log of break-glass and provisional decisions, drained by the provisional reconciler when HCM recovers.
- **Break-glass** — Explicit override allowing approval during HCM outage; requires elevated role and a configurable minimum outage duration.
- **Saga** — Multi-step workflow with compensating actions.
- **Transaction Confirmation** — Required field set on every HCM mutation response.

## 4. Source-of-Truth Model

| Concern | Authority | Local copy purpose |
|---|---|---|
| Balance value | HCM | UI display; pre-validation hint |
| Employment timeline | HCM | Request location attribution |
| LeaveTypeAvailability | HCM | Local pre-validation |
| Request lifecycle state | This service | Owned end-to-end |
| Approval decisions | This service | Owned; sent to HCM as deductions |
| Provisional decisions | This service | Owned; replayed against HCM on recovery |
| Idempotency keys | This service | Tracks inbound (client) and outbound (HCM) |
| Audit log + provisional action log | This service | Owned; append-only |

Request state and approval decisions are owned by this service. HCM doesn't know about ReadyOn requests as objects — it knows about balance debits/credits with transaction IDs. This service maps its requests to HCM transactions via `hcmTransactionId`. Provisional decisions exist only in this service until reconciled.

## 5. Domain Model

### 5.1 Balance

```
Balance {
  employeeId            string
  locationId            string
  leaveTypeId           string
  available             decimal      // last-known from HCM (decimal.js)
  pendingHold           decimal      // sum of PENDING_APPROVAL request units (local UX)
  approvedHold          decimal      // in-flight committed-but-unconfirmed approvals
  provisionalHold       decimal      // sum of PROVISIONALLY_APPROVED units awaiting reconciliation
  hcmVersion            bigint       // monotonic; supplied by HCM; ORDERING AUTHORITY
  hcmEffectiveAt        timestamp    // informational only (HCM wall clock)
  localUpdatedAt        timestamp
  lastReconciledAt      timestamp
  state                 BalanceState
  PRIMARY KEY (employeeId, locationId, leaveTypeId)
}
```

The three hold buckets serve distinct purposes. `pendingHold` is UX-only (shows the employee what they've requested). `approvedHold` is the brief in-flight window between the local decision and HCM's confirmation. `provisionalHold` is the durable accounting of break-glass approvals that have not yet been validated against HCM.

### 5.2 TimeOffRequest

```
TimeOffRequest {
  id                       uuid
  idempotencyKey           string       // unique, client-supplied
  inputHash                string       // canonical hash (§14.4)
  employeeId               string
  locationId               string       // derived at submission from Employment
  leaveTypeId              string
  startDate                date         // location-tz, no time component
  endDate                  date
  units                    decimal
  state                    RequestState
  hcmTransactionId         string?      // after successful HCM commit
  provisionalApprovalId    uuid?        // FK to ProvisionalAction if break-glass
  approvedBy               string?
  approvedAt               timestamp?
  rejectedReason           ErrorCode?
  rejectedAt               timestamp?
  cancelledAt              timestamp?
  escalatedAt              timestamp?
  escalationReason         text?
  createdAt                timestamp
  updatedAt                timestamp
  needsRevalidationReason  string?
}
```

### 5.3 Employment

```
Employment {
  employeeId            string
  locationId            string
  effectiveFrom         date
  effectiveTo           date?        // null = currently active
  hcmVersion            bigint
  PRIMARY KEY (employeeId, effectiveFrom)
}
```

`Employment.locationAt(employeeId, asOfDate)` returns the active location for that employee on that date.

### 5.4 LeaveTypeAvailability

```
LeaveTypeAvailability {
  locationId            string
  leaveTypeId           string
  isActive              boolean
  effectiveFrom         date
  effectiveTo           date?
  hcmVersion            bigint
  PRIMARY KEY (locationId, leaveTypeId, effectiveFrom)
}
```

### 5.5 Employee (bootstrap projection)

```
Employee {
  employeeId            string PRIMARY KEY
  bootstrappedAt        timestamp
  bootstrapSource       enum {WEBHOOK, LAZY_PULL, BATCH}
  hcmVersion            bigint
  lastSeenInBatchAt     timestamp?
}
```

The presence of this row means we have enough HCM-sourced data to operate on this employee. Absence triggers the bootstrap flow (§11).

### 5.6 ProvisionalAction (new — event-sourced)

```
ProvisionalAction {
  id                       uuid PRIMARY KEY
  type                     enum {BREAK_GLASS_APPROVAL, PROVISIONAL_CANCELLATION}
  requestId                uuid
  invokedBy                string         // actorId
  invokedAt                timestamp
  reason                   text           // human-typed justification (required)
  outageStartObservedAt    timestamp      // when we first saw HCM unavailable
  localStateSnapshot       json?          // full state at invocation (see retention rules below)
  localStateSnapshotSummary json?         // compact summary; populated after CONFIRMED/NO_OP
  reconciliationState      enum {PENDING, CONFIRMED, REJECTED_ESCALATED, NO_OP}
  reconciledAt             timestamp?
  reconciliationDetails    json?          // HCM response, classification
}
```

This is the canonical event-log for provisional decisions. Append-only convention (§5.8). The provisional reconciler (§9.5.3) drains entries with `reconciliationState = PENDING` once HCM is reachable.

#### 5.6.1 Snapshot retention policy (Rev 3.1, Q.θ)

`localStateSnapshot` carries the full balance + request + employment + leave-type-availability state captured at the moment of break-glass invocation. This is essential for HR investigation when reconciliation fails (`REJECTED_ESCALATED`), but it is storage growth that we should bound for the common case where reconciliation succeeds.

The policy is **summarize on success, retain in full on escalation**:

| Reconciliation outcome | `localStateSnapshot` | `localStateSnapshotSummary` |
|---|---|---|
| `PENDING` (in flight) | full JSON | null |
| `CONFIRMED` | nulled out | compact summary (balance hash, request IDs, decision metadata, ~200 bytes) |
| `NO_OP` (pair-coalesced or already-reconciled) | nulled out | compact summary |
| `REJECTED_ESCALATED` | retained in full **indefinitely** | also populated |

The summarization happens in the same atomic transaction as the reconciliation outcome (in `markReconciled`), so the full snapshot and the summary are never both null and never both fully present except briefly during the in-flight window.

**Rationale.** HR will only investigate ESCALATED outcomes. For CONFIRMED and NO_OP, the audit chain (`AuditEvent` + `ReconciliationStep` rows) is sufficient — if someone really needs to reconstruct the moment of break-glass, the audit log carries enough context. We trade a small loss of forensic capability on confirmed cases for unbounded storage savings.

**Configuration knob.** `reconciler.snapshotRetention.summarizeAfterSuccess` defaults to `true`. Setting it to `false` retains all snapshots in full (useful for compliance-heavy deployments). Operationally, retention archival to a separate cold-storage table is future work (TRD §21).

**Append-only compatibility.** Nulling out `localStateSnapshot` on reconciliation success is the only mutation to a non-allow-listed field this design permits, and it's added explicitly to the allow-list in §5.8.1. The summary write is also part of the same allow-list update. Both fields are documented in the repository contract as "updatable only by `markReconciled`."

### 5.7 Outbox & Inbox & Idempotency & Audit

```
OutboxEntry {
  id                    uuid
  type                  enum {RESERVE_BALANCE, RELEASE_BALANCE, FETCH_BALANCE,
                              BOOTSTRAP_EMPLOYEE, RECONCILE_PROVISIONAL}
  payload               json
  state                 OutboxState
  attempts              int
  nextAttemptAt         timestamp
  lastError             text?
  idempotencyKey        string         // stable across retries
  createdAt             timestamp
  updatedAt             timestamp
}

InboxEvent {
  id                    string         // HCM-supplied event id; dedupe key
  source                enum {WEBHOOK, BATCH}
  type                  enum {BALANCE_UPDATED, EMPLOYMENT_CHANGED,
                              LEAVE_TYPE_CHANGED, EMPLOYEE_CREATED}
  payload               json
  hcmVersion            bigint
  receivedAt            timestamp
  processedAt           timestamp?
  processingError       text?
}

IdempotencyKey {
  key                   string PRIMARY KEY
  inputHash             string         // canonical (§14.4)
  responseSnapshot      json
  createdAt             timestamp
  expiresAt             timestamp
}

AuditEvent {
  id                    uuid
  entityType            string
  entityId              string
  actor                 string
  action                string
  before                json?
  after                 json?
  correlationId         string
  occurredAt            timestamp
}

ReconciliationStep {   // NEW (Q.γ) — per-step event log for provisional reconciler
  id                    uuid PRIMARY KEY
  actionId              uuid           // FK to ProvisionalAction.id
  stepSequence          int            // monotonic within action; gaps allowed across crashes
  kind                  enum {
                          HCM_HISTORY_QUERIED,
                          HCM_HISTORY_QUERY_FAILED,
                          HISTORY_MISMATCH,
                          HCM_CALL_IN_FLIGHT,
                          OUTCOME_APPLIED,
                          OUTCOME_INVALID,
                          PAIR_COALESCED,
                          EMPLOYEE_NOT_FOUND_AT_HCM,   // Rev 3.1 (Q.ν)
                          TERMINAL          // synthetic; written when action reaches terminal
                        }
  outcome               enum {PARTIAL, TERMINAL}
  payload               json             // serialized inputs and outputs for replayability
  occurredAt            timestamp
  workerId              string           // which worker instance wrote this row
}
```

### 5.8 Append-only convention for ProvisionalAction and ReconciliationStep (Q.δ)

Both `ProvisionalAction` and `ReconciliationStep` are append-only event logs. The decision rationale:

**What "append-only" means here:**

1. **No row is ever deleted.** Cleanup is by archival to a separate table after `eventLogRetentionMs` (default: never within the exercise; in production, configurable per compliance policy).
2. **`ReconciliationStep` rows are never updated at all** — every step is a new row.
3. **`ProvisionalAction` rows ARE updated, but only on a closed allow-list of fields**: `reconciliationState`, `reconciledAt`, `reconciliationDetails`. All other fields are immutable after insert. This is enforced at the repository layer (see §5.8.1).

**Why not strict append-only for `ProvisionalAction` (option discussed in Q.δ)?**

Two coherent designs were considered:

- **(a) Limited updates allowed on `ProvisionalAction`, enforced by repository convention.** Simpler schema, fewer joins, less storage. **(Selected.)**
- **(b) Strict append-only — store reconciliation outcomes as additional rows in `ProvisionalActionReconciliation`.** Pure event-sourcing; auditability via lineage queries. *Rejected* as over-engineering for this scope. The `ReconciliationStep` log already provides the lineage; storing the outcome both as `ReconciliationStep` (terminal kind) and as a `ProvisionalAction` update is redundant when the repository convention pins the update.

The decision is documented; a future migration to (b) is straightforward if compliance requires it.

#### 5.8.1 Repository-level enforcement

The `ProvisionalActionRepository` exposes only these mutation methods:

- `insert(row)` — used at break-glass invocation. Sets `reconciliationState = PENDING`.
- `markReconciled(actionId, finalState, details, summary)` — used by the reconciler. Atomically updates the **five** allow-listed fields (Rev 3.1, Q.θ): `reconciliationState`, `reconciledAt`, `reconciliationDetails`, `localStateSnapshot` (only to null it out on success/no-op), `localStateSnapshotSummary` (only on terminal). Throws if any other field is touched (defensive: invocation goes through a strict zod schema that whitelists only those five fields).
- No `update(...)` method exists.
- No `delete(...)` method exists.

For belt-and-suspenders, a SQLite trigger may be added (optional, configurable via migration) that rejects any `UPDATE` outside the allow-listed fields. Trigger code is generated from the same allow-list to keep them in sync.

For `ReconciliationStep`: only `insert(row)` exists. No update, no delete, no exceptions. This is enforced by repository contract and (optionally) by a trigger.

**Event-driven implications.** Treating these tables as append-only is what makes the provisional reconciler an event-driven system rather than a request/response system. Each `ReconciliationStep` row is an immutable event; the reconciler is a consumer that reads its own prior events to determine where to resume. The audit chain is a sequence of events, not a snapshot of state.

### 5.9 ReconcilerLease (NEW in Rev 3.1, Q.ι)

Single-row advisory lock backing the provisional reconciler's mutual exclusion.

```
ReconcilerLease {
  id           string PRIMARY KEY   // 'provisional' (fixed key — one lease, one row)
  heldBy       string?              // workerId, or null when free
  acquiredAt   timestamp?
  expiresAt    timestamp?           // acquiredAt + leaseTtlMs
}
```

**Design choices and rationale.**

A row-based lease was chosen over the alternative of relying on SQLite's `BEGIN EXCLUSIVE` for two reasons:

1. **Debuggability.** A developer or operator can `SELECT * FROM reconciler_lease WHERE id='provisional'` at any moment to see who holds the lock and when it was acquired. With `BEGIN EXCLUSIVE`, this information is implicit and ephemeral.
2. **Crash safety.** If the holder crashes without releasing, the `expiresAt` timestamp lets a subsequent worker steal the lease once `now > expiresAt`. With `BEGIN EXCLUSIVE`, the lock is released on connection close — which is correct, but harder to audit if the connection close was abrupt.

**Acquisition is a single atomic statement:**

```sql
UPDATE reconciler_lease
   SET heldBy = ?, acquiredAt = ?, expiresAt = ?
 WHERE id = 'provisional'
   AND (heldBy IS NULL OR expiresAt < ?)
RETURNING *;
```

If the `UPDATE` affects zero rows, the lease is held by another worker. The reconciler skips this tick.

**Release on success:**

```sql
UPDATE reconciler_lease
   SET heldBy = NULL, acquiredAt = NULL, expiresAt = NULL
 WHERE id = 'provisional' AND heldBy = ?;
```

The `heldBy = ?` predicate prevents a confused worker from releasing someone else's lease (e.g., after a lease expiration + reacquisition by another worker).

**TTL.** `reconciler.leaseTtlMs` defaults to 60 seconds. Any single reconciliation tick that runs longer than this is anomalous and should be alerted. The TTL is intentionally short so a crashed worker doesn't block reconciliation for hours.

**Postgres migration note.** Under Postgres (Future Work, §21), this table can be replaced by `pg_advisory_lock`, which is session-scoped and auto-released on disconnect. The application code stays the same shape; only the underlying primitive changes.

## 6. State Vocabulary (three-axis, plus provisional reconciliation axis)

Three orthogonal state machines for normal operation, plus an embedded state on `ProvisionalAction` rows.

### 6.1 BalanceState

| State | Trigger | Resolution path |
|---|---|---|
| `SYNCED` | Last reconciliation successful and recent | Steady state |
| `RECONCILING` | Reconciliation job in progress on this row | → `SYNCED` on completion |
| `UNDER_HOLD_DEFICIT` | After an inbound update, `available < pendingHold + approvedHold + provisionalHold` | All affected requests → `NEEDS_REVALIDATION`; reconciler resolves; → `SYNCED` |
| `STALE` | `now - lastReconciledAt > staleThreshold` | Triggers an immediate point-read; → `SYNCED` |

### 6.2 RequestState (updated)

| State | Trigger | Resolution path |
|---|---|---|
| `DRAFT` | Created but not submitted (optional) | → `PENDING_APPROVAL` on submit |
| `PENDING_APPROVAL` | Submitted by employee | → `AWAITING_HCM_COMMIT`, `PROVISIONALLY_APPROVED`, `REJECTED`, or `CANCELLED` |
| `AWAITING_HCM_COMMIT` | Manager approved; outbox entry enqueued | → `APPROVED` on HCM success, `REJECTED` on HCM rejection, stays put on retryable |
| `PROVISIONALLY_APPROVED` | Break-glass approval during HCM outage | → `APPROVED` on HCM reconciliation success, → `ESCALATED_TO_HR` on rejection |
| `APPROVED` | HCM transaction confirmation valid | → `CANCELLATION_PENDING` on cancel, → `TAKEN` when leave end date passes |
| `REJECTED` | Rejected by manager or HCM | Terminal |
| `CANCELLATION_PENDING` | Cancellation initiated, HCM credit in flight | → `CANCELLED` on confirmation |
| `CANCELLED` | Cancellation confirmed (or provisionally cancelled and reconciled) | Terminal |
| `TAKEN` | Leave end date passed without cancellation | Terminal. **If `hrReviewFlag = true`**: surfaces in HR review queue. Path: `PROVISIONALLY_APPROVED → TAKEN` where HCM rejected reconciliation post-leave-date (§9.5.5). |
| `NEEDS_REVALIDATION` | Underlying balance, employment, or leave-type availability changed | → revert to prior state if still valid, → `REJECTED` if no longer valid |
| `ESCALATED_TO_HR` | Provisional reconciliation revealed HCM rejection of a `PROVISIONALLY_APPROVED` request | Terminal in software; resolved by manual HR process |

### 6.3 OutboxState

Unchanged from Rev 1: `PENDING → IN_FLIGHT → SUCCEEDED | SUSPECT_NO_OP | FAILED_RETRYABLE | FAILED_PERMANENT`.

### 6.4 ProvisionalAction.reconciliationState

| State | Trigger | Resolution path |
|---|---|---|
| `PENDING` | Provisional action recorded; HCM still unavailable or reconciler hasn't run yet | → `CONFIRMED`, `REJECTED_ESCALATED`, or `NO_OP` |
| `CONFIRMED` | HCM accepted the equivalent operation on reconciliation | Terminal |
| `REJECTED_ESCALATED` | HCM rejected; request → `ESCALATED_TO_HR` | Terminal (in software) |
| `NO_OP` | Reconciliation determined no action needed (e.g., provisional cancellation of a request HCM never debited) | Terminal |

## 7. GraphQL API

Why GraphQL: ReadyOn uses GraphQL in production. The UI benefits from compound queries. All mutations require client-supplied idempotency keys.

### 7.1 Schema sketch (additions for break-glass)

```graphql
scalar DateTime
scalar Date
scalar Decimal

type Query {
  balance(employeeId: ID!, locationId: ID!, leaveTypeId: ID!): Balance
  balances(employeeId: ID!): [Balance!]!
  employment(employeeId: ID!): [EmploymentPeriod!]!
  leaveTypesAvailableAt(employeeId: ID!, asOf: Date!): [LeaveTypeOption!]!
  timeOffRequest(id: ID!): TimeOffRequest
  timeOffRequests(employeeId: ID!, states: [RequestState!]): [TimeOffRequest!]!
  provisionalActions(filter: ProvisionalActionFilter): [ProvisionalAction!]!
  hcmHealth: HcmHealthStatus!

  # NEW (Q.β, paginated in Rev 3.1 per Q.μ): Surfaces requests requiring HR attention.
  # Three categories:
  #   1. state = ESCALATED_TO_HR (HCM rejected provisional approval pre-leave)
  #   2. state = TAKEN AND hrReviewFlag = true (HCM rejected provisional approval post-leave)
  #   3. state = CANCELLATION_PENDING AND age > cancellationPendingAlertThresholdMs
  # Requires hr_admin role at gateway.
  # Pagination follows Relay-style cursor pagination (`first`, `after`).
  hrReviewQueue(
    categories: [HrReviewCategory!],
    employeeId: ID,
    locationId: ID,
    first: Int = 50,            # page size; default 50, max 200
    after: String               # opaque cursor from previous page's pageInfo.endCursor
  ): HrReviewItemConnection!
}

type Mutation {
  createTimeOffRequest(input: CreateTimeOffRequestInput!, idempotencyKey: ID!): TimeOffRequestPayload!
  approveTimeOffRequest(id: ID!, approverId: ID!, idempotencyKey: ID!): TimeOffRequestPayload!

  # Break-glass: only callable by users with break_glass_approver role,
  # only when HCM has been unavailable >= breakGlassMinOutageMs.
  approveTimeOffRequestProvisionally(
    id: ID!,
    approverId: ID!,
    justification: String!,
    idempotencyKey: ID!
  ): TimeOffRequestPayload!

  rejectTimeOffRequest(id: ID!, approverId: ID!, reason: String, idempotencyKey: ID!): TimeOffRequestPayload!
  cancelTimeOffRequest(id: ID!, actorId: ID!, idempotencyKey: ID!): TimeOffRequestPayload!

  # Internal — protected at gateway
  ingestHcmEvent(input: HcmEventInput!): IngestPayload!
  triggerReconciliation(employeeId: ID, locationId: ID): ReconciliationJob!
  triggerProvisionalReconciliation: ReconciliationJob!
}

type HcmHealthStatus {
  reachable: Boolean!
  outageStartedAt: DateTime          # null if reachable
  breakGlassAvailable: Boolean!      # true if outage exceeds threshold AND caller has role
}

type ProvisionalAction {
  id: ID!
  type: ProvisionalActionType!
  requestId: ID!
  invokedBy: ID!
  invokedAt: DateTime!
  reason: String!
  reconciliationState: ProvisionalReconciliationState!
  reconciledAt: DateTime
  request: TimeOffRequest!
  reconciliationSteps: [ReconciliationStep!]!   # NEW (Q.γ)
}

# NEW (Q.γ): exposed for HR audit. Read-only.
type ReconciliationStep {
  id: ID!
  actionId: ID!
  stepSequence: Int!
  kind: ReconciliationStepKind!
  outcome: ReconciliationStepOutcome!
  occurredAt: DateTime!
}

# NEW (Q.β): HR review queue surfaces requests requiring attention.
enum HrReviewCategory {
  ESCALATED_PRE_LEAVE       # state = ESCALATED_TO_HR
  ESCALATED_POST_LEAVE      # state = TAKEN AND hrReviewFlag = true
  CANCELLATION_STUCK        # state = CANCELLATION_PENDING AND age > threshold
}

type HrReviewItem {
  request: TimeOffRequest!
  category: HrReviewCategory!
  flaggedAt: DateTime!
  reason: String!
  provisionalActions: [ProvisionalAction!]!
}

# NEW (Rev 3.1, Q.μ): Relay-style paginated connection for HR Review Queue.
type HrReviewItemConnection {
  edges: [HrReviewItemEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!            # count across all pages matching the filter
}

type HrReviewItemEdge {
  node: HrReviewItem!
  cursor: String!             # opaque; usable as `after` on next query
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

**Pagination semantics (Q.μ).**

- **Order.** Items are returned ordered by `flaggedAt DESC` (most recently flagged first). Stable secondary sort by `request.id` for ties.
- **Cursor opacity.** The cursor is a base64-encoded JSON blob (e.g., `{"flaggedAt":"...","id":"..."}`). Clients treat it as opaque; only the server interprets it. Future cursor format changes don't break clients that pass through what they received.
- **`first` constraint.** Default 50, max 200. Requests above max are clamped silently with a `Warning` extension in the response (preserving the user's intent without erroring).
- **`totalCount`.** Computed; potentially expensive on very large queues. The query is indexed by `(category, flaggedAt)` so this remains O(matching rows) which is bounded by the number of escalations — typically small. If queues grow large, future work moves `totalCount` to an estimate.
- **No `last`/`before`.** Forward pagination only. Reverse pagination is future work; the use case (HR working through a queue front-to-back) doesn't require it.
- **Stability.** New items appearing during pagination (e.g., a new escalation occurs while HR is paging through) will be visible on a subsequent first-page request but won't disrupt the in-flight cursor — the cursor encodes `flaggedAt`, so newer items have a `flaggedAt > cursor.flaggedAt` and would appear on page 1 of the next refresh.

### 7.2 Idempotency semantics

Every mutation requires `idempotencyKey: ID!`. Detailed in §14.

## 8. Architecture & Process Topology

### 8.1 Single process, multi-module (unchanged)

One NestJS process, multiple modules. Workers run as `@Injectable()` services with `@Cron` or `setInterval`, in the same process.

Modules: `ApiModule`, `RequestModule`, `BalanceModule`, `EmploymentModule`, `LeaveTypeAvailabilityModule`, `EmployeeBootstrapModule` (new), `ProvisionalActionModule` (new), `OutboxModule`, `InboxModule`, `OutboxWorkerModule`, `InboxProcessorModule`, `ReconciliationModule` (extended with provisional reconciler), `HcmAdapterModule` (extended with health monitor), `HcmHealthModule` (new), `AuditModule`, `ConfigModule`, `AuthModule`.

### 8.2 Why polling, not BullMQ + Redis

Unchanged. Summary of rationale (full version in `02_Assumptions_and_Decisions.md`):

1. **Transactional consistency.** Outbox-in-SQLite gives us atomic enqueue-with-domain-write in one transaction. Redis adds a dual-write window.
2. **Dependency cost.** Single deployable artifact remains the goal.
3. **Test determinism.** Polling intervals controlled in tests; `worker.tick()` runs synchronously.
4. **Throughput.** Human-scale write rates do not justify the operational complexity.
5. **Failure semantics under our control.** Backoff math is a small amount of code; using Bull means using *their* assumptions about idempotency, retry, and dead-letter, which may not match ours.

When we revisit: when we move to Postgres and HCM throughput exceeds hundreds of calls/second sustained.

### 8.3 Process topology

```
┌──────────────────────────────────────────────────────────────┐
│ NestJS Process (single)                                       │
│                                                               │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────────────┐   │
│  │ GraphQL  │──▶│  Domain      │──▶│  Repositories       │   │
│  │ ApiModule│   │  Services    │   │  (TypeORM)          │   │
│  └──────────┘   └──────────────┘   └────────┬────────────┘   │
│                                              │                │
│  ┌──────────────────────────────────────────┼─────────┐      │
│  │              SQLite (WAL mode, ≥ 3.35)             │      │
│  │  balance | request | employee | provisional_action │      │
│  │  outbox  | inbox   | audit    | idempotency_key    │      │
│  └────────┬────────────────────────────────────┬──────┘      │
│           │                                    │              │
│  ┌────────┼─────────┐                ┌─────────┼─────────┐    │
│  │ Outbox Worker   │                │ Inbox Processor  │     │
│  └────────┬─────────┘                └──────────────────┘     │
│           │                                                   │
│  ┌────────┼─────────┐  ┌────────────────┐ ┌──────────────┐   │
│  │ Reconciler      │  │ Provisional    │ │ HCM Health   │    │
│  │ (3 cadences)    │  │ Reconciler     │ │ Monitor      │    │
│  └────────┬─────────┘  └────────┬───────┘ └──────┬───────┘    │
│           │                     │                │            │
│           └──────────┬──────────┴────────────────┘            │
│                     │                                         │
│                     ▼                                         │
│           ┌──────────────────┐                                │
│           │ HCM Adapter Port │                                │
│           └────────┬─────────┘                                │
└────────────────────┼──────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │  Mock HCM Server        │
        │  (separate process,     │
        │   with its own SQLite)  │
        └─────────────────────────┘
```

## 9. Request Lifecycle (Saga)

### 9.1 Create

```
POST createTimeOffRequest(input, idempotencyKey)
  │
[1] Validate input shape (dates, units, employeeId exists in Employee table).
    [1a] If employee not bootstrapped: trigger lazy bootstrap (§11.3),
         wait for completion or fail with EMPLOYEE_NOT_BOOTSTRAPPED.
[2] Resolve idempotency key (§14.1).
[3] Lookup Employment.locationAt(input.startDate) → locationId.
    [3a] If locationAt(start) ≠ locationAt(end): REQUEST_SPANS_LOCATION_TRANSFER.
    [3b] If no employment record: EMPLOYMENT_NOT_FOUND.
[4] Verify (locationId, leaveTypeId) in LeaveTypeAvailability.
[5] Live HCM check: fetchBalance(employeeId, locationId, leaveTypeId).
    [5a] Sufficient: proceed.
    [5b] Insufficient: return INSUFFICIENT_BALANCE_HCM.
    [5c] HCM unavailable: WARN, proceed using local projection (advisory
         pre-validation only; approval will re-check). Asymmetric with approve:
         create is informational, approve is dispositive.
[6] BEGIN TX:
      Insert request as PENDING_APPROVAL
      Increment Balance.pendingHold by units
      Insert IdempotencyKey row with response snapshot
      Insert AuditEvent (action=CREATE)
    COMMIT
[7] Return request.
```

### 9.2 Approve (normal path)

```
POST approveTimeOffRequest(id, approverId, idempotencyKey)
  │
[1] Resolve idempotency.
[2] Load request; verify state == PENDING_APPROVAL.
    Verify approverId is authorized AND approverId != request.employeeId.
[3] Re-derive locationId via Employment.locationAt(request.startDate).
    [3a] If location changed since submission: trigger NEEDS_REVALIDATION flow.
[4] Live HCM call: reserveBalance(employeeId, locationId, leaveTypeId, units, idempotencyKey).
[5] HCM unavailable:
    Check HcmHealthMonitor.outageStartedAt.
    [5a] If outage duration < breakGlassMinOutageMs: return HCM_UNAVAILABLE.
         The approver may retry; the UI does not yet offer break-glass.
    [5b] If outage duration >= breakGlassMinOutageMs AND approver has break_glass_approver role:
         Return HCM_UNAVAILABLE with a flag in the payload indicating
         break-glass is available. UI prompts approver to use the
         approveTimeOffRequestProvisionally mutation (§9.5).
    [5c] If outage duration >= threshold but approver lacks role:
         Return HCM_UNAVAILABLE with break-glass NOT available.
[6] HCM rejection (insufficient/invalid):
    BEGIN TX:
      Decrement Balance.pendingHold by units
      Set request state = REJECTED, rejectedReason = INSUFFICIENT_BALANCE_HCM
      Insert AuditEvent
      Insert IdempotencyKey snapshot
    COMMIT
    Return REJECTED request + INSUFFICIENT_BALANCE_HCM error.
[7] HCM success:
    Validate transaction confirmation strictly (§13.2).
    [7a] If valid:
         BEGIN TX:
           Decrement Balance.pendingHold by units
           Set Balance.available = response.newAvailable
           Set Balance.hcmVersion = response.hcmVersion
           Set request state = APPROVED, hcmTransactionId = response.txId
           Insert AuditEvent
           Insert IdempotencyKey snapshot
         COMMIT
         Return APPROVED request.
    [7b] If invalid (suspect no-op):
         BEGIN TX:
           Set Balance.state = RECONCILING
           Increment Balance.approvedHold by units
           Decrement Balance.pendingHold by units
           Set request state = AWAITING_HCM_COMMIT
           Schedule reconciliation job
         COMMIT
         Reconciler resolves.
```

### 9.3 Reject (by manager)

Local-only transition; no HCM call. Releases `pendingHold`. Audit-logged.

### 9.4 Cancel

**Asymmetric with approval:** cancellation is a credit operation; risk of being wrong is bounded. During HCM outage, cancellation proceeds provisionally without a role gate. **However**, to ensure the user understands the operation is provisional, the API requires an explicit acknowledgment field on the mutation when HCM is unavailable.

```graphql
input CancelTimeOffRequestInput {
  id: ID!
  actorId: ID!
  acknowledgedHcmUnavailable: Boolean
  # Required to be `true` only when HCM is unavailable AND the request is APPROVED.
  # The UI is responsible for setting this after surfacing the warning to the user.
  # If absent during outage on an APPROVED request, the mutation fails with
  # CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT and the UI must surface the warning.
}
```

```
POST cancelTimeOffRequest(input, idempotencyKey)
  │
[1] Resolve idempotency. Load request.
[2] State checks:
    PENDING_APPROVAL → local cancel, release pendingHold. CANCELLED. Terminal.
    AWAITING_HCM_COMMIT → reject with STATE_TRANSITION_NOT_ALLOWED; caller waits.
    PROVISIONALLY_APPROVED → record cancellation provisionally (see §9.5.4).
    APPROVED → see [3] below.
    TAKEN, CANCELLED, REJECTED, ESCALATED_TO_HR → TERMINAL_STATE_REACHED.
[3] For APPROVED cancellation:
    [3.0] Check HCM health.
          If HCM is UNHEALTHY AND acknowledgedHcmUnavailable != true:
            Return CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT.
            The UI surfaces a warning: "HCM is currently unreachable. Your
            cancellation will be recorded but may take time to confirm.
            Continue?" When user confirms, the UI retries with the flag set.
          If HCM is UNHEALTHY AND acknowledgedHcmUnavailable == true:
            Proceed to provisional cancellation flow (§9.5.4).
          If HCM is HEALTHY:
            Proceed to [3.1].
    [3.1] Outbox worker attempts HCM credit.
    [3a] HCM available + success: state CANCELLED. Audit.
    [3b] HCM unavailable (transient, encountered after enqueue): state remains
         CANCELLATION_PENDING. Outbox retries.
         After cancellationPendingAlertThresholdMs (default 1h) of being
         in CANCELLATION_PENDING, emit a CANCELLATION_TAKING_LONGER_THAN_EXPECTED
         AuditEvent. The user-facing display is product-team's call (not
         specified here); the audit trail and the alert exist.
    [3c] HCM responds with permanent rejection (rare; idempotency replay
         should have returned prior success): mark CANCELLATION_PENDING
         indefinitely with audit, surface to ops, do not auto-revert.
[4] Provisional cancellation flow: see §9.5.4.
```

**Assumption (Q.α).** The `acknowledgedHcmUnavailable` flag is the contract by which the UI proves it has shown the user the warning. The server cannot directly verify the UI rendered anything; it can only require the flag and audit who set it. The audit chain establishes "caller asserted acknowledgment" — if a UI is buggy and sets the flag without showing the warning, that's a UI bug, not a server-side correctness violation. We accept this boundary and document it loudly. The flag is *always logged* in the audit event for the provisional cancellation.

**Why asymmetric (recap of Q.α reasoning).** Approval is a debit operation: being wrong creates a balance shortfall the employee may not be entitled to. Cancellation is a credit operation: being wrong creates a balance the employee already had. The downside cases are categorically different, justifying the differential gate (role + outage threshold for approve; flag + outage for cancel).

### 9.5 Break-Glass and Provisional Reconciliation

This is new in Revision 2. The mechanism allows continued operation during sustained HCM outages while preserving HCM's role as eventual source of truth.

#### 9.5.1 When break-glass is available

HCM health is monitored continuously by `HcmHealthMonitor` (every `healthCheckIntervalMs`, default 5s). On consecutive failed health checks, the monitor records `outageStartedAt`. Break-glass becomes available when:

1. `now - outageStartedAt >= breakGlassMinOutageMs` (default 60 seconds, configurable).
2. The current actor has the `break_glass_approver` role.
3. The request is in `PENDING_APPROVAL`.

The minimum-outage threshold prevents abuse during transient HCM hiccups. The role gate ensures only senior approvers can invoke. The threshold and role are both audited per invocation.

#### 9.5.2 Provisional approval flow

```
POST approveTimeOffRequestProvisionally(id, approverId, justification, idempotencyKey)
  │
[1] Resolve idempotency.
[2] Verify approver has break_glass_approver role.
    On failure: BREAK_GLASS_NOT_AUTHORIZED.
[3] Verify HCM has been unavailable >= breakGlassMinOutageMs.
    On failure: BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET.
[4] Verify request is in PENDING_APPROVAL.
    Verify approverId != request.employeeId.
[5] Verify justification is present and non-empty (audit requirement).
[6] BEGIN TX:
      Insert ProvisionalAction {
        type: BREAK_GLASS_APPROVAL,
        requestId, invokedBy: approverId,
        invokedAt: now,
        reason: justification,
        outageStartObservedAt: HcmHealthMonitor.outageStartedAt,
        localStateSnapshot: { balance, request, employment, leaveTypeAvail },
        reconciliationState: PENDING
      }
      Set request.state = PROVISIONALLY_APPROVED
      Set request.provisionalApprovalId = <new ProvisionalAction.id>
      Decrement Balance.pendingHold by units
      Increment Balance.provisionalHold by units
      Insert AuditEvent (action=BREAK_GLASS_APPROVAL_INVOKED, with full snapshot)
      Insert IdempotencyKey snapshot
    COMMIT
[7] Return request with state PROVISIONALLY_APPROVED. The response includes
    a clear note that this approval is awaiting HCM reconciliation and may
    be escalated to HR if HCM rejects.
```

The `ProvisionalAction` row is the event in event-driven reconciliation. It captures *everything* needed to make a defensible decision on recovery.

#### 9.5.3 Provisional reconciliation (when HCM is back) — formalized algorithm

The `HcmHealthMonitor` transitions from `UNAVAILABLE` to `REACHABLE` when health checks succeed consistently for `healthRecoveryWindowMs` (default 60s — avoids flapping). On transition, it emits a `HCM_RECOVERED` domain event.

The `ProvisionalReconciler` subscribes to `HCM_RECOVERED` and to a periodic timer (`provisionalReconcilerIntervalMs`, default 30s while pending actions exist). On either trigger, it drains the pending actions.

**Event-driven nature.** Every step the reconciler takes is recorded as a row in `ReconciliationStep` (see §5.7 below). The step log is append-only, gives the reconciler at-most-once execution semantics per step, and is the durable record that allows resuming a reconciliation that was interrupted by a crash. This is event-driven architecture: the `ProvisionalAction` is the event-of-decision; the `ReconciliationStep` rows are events-of-execution; together they form the audit chain from decision to settlement.

**The algorithm explicitly avoids double-action against HCM.** Before issuing any reserve/release, we query HCM for an existing transaction matching this provisional action's idempotency key. If found, we treat the existing transaction as evidence the action was already applied — we never call reserve/release twice for the same provisional action.

```
ProvisionalReconciler.drain():
  │
[0] Idempotency guard for the entire pass:
    Acquire single-row advisory lock (UPDATE reconciler_lease SET ...
    WHERE id='provisional' AND held_by IS NULL RETURNING *).
    If lease unavailable: another worker is running; skip this tick.

[1] Pair coalescing pass (Q.ζ):
    For each request_id with multiple PENDING ProvisionalActions:
      If actions form an opposing pair (BREAK_GLASS_APPROVAL +
      PROVISIONAL_CANCELLATION on the same request): mark BOTH as NO_OP
      in a single TX. Emit AuditEvent (PROVISIONAL_PAIR_COALESCED).
      Insert ReconciliationStep rows: kind=PAIR_COALESCED for each action.
      No HCM call.

[2] Load remaining PENDING ProvisionalActions (after coalescing),
    ordered by invokedAt ASC for fairness.

[3] For each action:
    [3.0] CRITICAL: load the most recent ReconciliationStep for this action.
          If lastStep.outcome == TERMINAL (CONFIRMED, REJECTED_ESCALATED,
          NO_OP, FAILED_PERMANENT): the action has already been reconciled.
          Skip. (Idempotency guard for restart safety.)
          If lastStep.outcome == PARTIAL (HCM_HISTORY_QUERIED,
          HCM_CALL_IN_FLIGHT): the action is mid-reconciliation;
          resume from that step.

    [3.1] PRE-FLIGHT TRANSACTION HISTORY QUERY (Q.γ — required):
          Call HCM: queryTransactions({
            employeeId, locationId, leaveTypeId,
            idempotencyKey: action.id,   // our stable key
            window: [action.invokedAt - reconciler.historyQueryWindowMs, now()]
            // Default window is 24h (Rev 3.1, Q.κ). Wide enough to cover
            // multi-day outages plus reconciler delay; narrow enough that
            // unrelated transactions on the same dimension don't pollute
            // the result. Configurable via reconciler.historyQueryWindowMs.
          })
          Insert ReconciliationStep { actionId: action.id,
            kind: HCM_HISTORY_QUERIED, queryResult: <serialized> }

          [3.1a] If history shows an existing transaction with our
                 idempotencyKey AND matching delta:
                   The action was ALREADY APPLIED at HCM
                   (likely a prior reconciler attempt or out-of-band).
                   Skip the reserve/release call. Treat as if the call
                   succeeded with the existing transaction.
                   Proceed to [3.3] with the existing transaction.
          [3.1b] If history shows an existing transaction with our
                 idempotencyKey but MISMATCHED delta:
                   Mark action as REJECTED_ESCALATED with reason
                   "HCM transaction exists with different delta — manual review".
                   Insert ReconciliationStep { kind: HISTORY_MISMATCH, ... }.
                   Continue to next action.
          [3.1c] If history shows no transaction:
                   Proceed to [3.2] to actually call HCM.
          [3.1d] If history query fails (HCM transient): leave action
                 PENDING. Retry next tick. Insert ReconciliationStep
                 { kind: HCM_HISTORY_QUERY_FAILED, error: <details> }.
          [3.1e] (Rev 3.1, Q.ν) If HCM returns EMPLOYEE_NOT_FOUND during
                 the history query (employee was deleted in HCM between
                 break-glass invocation and reconciliation):
                   BEGIN TX:
                     Insert ReconciliationStep { kind:
                       EMPLOYEE_NOT_FOUND_AT_HCM,
                       payload: { employeeId, action_id } }
                     Set request.state = ESCALATED_TO_HR
                     Set request.hrReviewReason =
                       "Employee no longer exists in HCM"
                     Set request.escalatedAt = now
                     Set ProvisionalAction.reconciliationState =
                       REJECTED_ESCALATED
                     Set ProvisionalAction.reconciliationDetails =
                       { kind: 'EMPLOYEE_DELETED', queriedAt: now }
                     Insert AuditEvent (PROVISIONAL_APPROVAL_ESCALATED,
                       severity=HIGH, subcategory=EMPLOYEE_DELETED)
                     Insert TERMINAL ReconciliationStep
                   COMMIT
                   The request surfaces in HR Review Queue with category
                   ESCALATED_PRE_LEAVE or ESCALATED_POST_LEAVE depending
                   on whether the leave date has passed.

    [3.2] CALL HCM:
          Insert ReconciliationStep { actionId: action.id, kind:
            HCM_CALL_IN_FLIGHT, call_payload: <serialized> }.

          Case BREAK_GLASS_APPROVAL:
            response = HCM.reserveBalance({ ...action.payload,
                                            idempotencyKey: action.id })
          Case PROVISIONAL_CANCELLATION:
            response = HCM.releaseBalance({ ...action.payload,
                                            idempotencyKey: action.id })

          (Rev 3.1, Q.ν) If reserveBalance/releaseBalance returns
          EMPLOYEE_NOT_FOUND: handle identically to [3.1e] above.

    [3.3] APPLY OUTCOME:
          BEGIN TX:
            Insert ReconciliationStep { actionId: action.id,
              kind: OUTCOME_APPLIED, hcm_response: <serialized> }
            Validate HCM response (see §13.2). If invalid: ROLLBACK; mark
              ReconciliationStep kind=OUTCOME_INVALID; leave action PENDING
              (retry).
            If valid & action == BREAK_GLASS_APPROVAL & HCM accepted:
              Decrement Balance.provisionalHold by units
              Set Balance.available = response.newAvailable
              Set Balance.hcmVersion = response.hcmVersion
              Set request.state = APPROVED, hcmTransactionId = response.txId
              Set ProvisionalAction.reconciliationState = CONFIRMED
              Set ProvisionalAction.reconciledAt = now
              Insert AuditEvent (PROVISIONAL_APPROVAL_CONFIRMED)
            If valid & action == BREAK_GLASS_APPROVAL & HCM rejected:
              Decrement Balance.provisionalHold by units
              Set request.state = ESCALATED_TO_HR (or TAKEN if endDate
                passed; see §9.5.5)
              Set request.escalatedAt = now, hrReviewFlag = true,
                hrReviewReason = "HCM rejected provisional approval"
              Set ProvisionalAction.reconciliationState = REJECTED_ESCALATED
              Insert AuditEvent (PROVISIONAL_APPROVAL_ESCALATED, severity=HIGH)
            If valid & action == PROVISIONAL_CANCELLATION:
              Symmetric logic with releaseBalance outcomes.
          COMMIT

[4] Release advisory lock.
[5] Emit summary AuditEvent (PROVISIONAL_RECONCILIATION_PASS_COMPLETED)
    with counts per outcome.
```

**Idempotency guarantees (Q.γ).** Three layers stack:

1. **Our key is the ProvisionalAction.id**, stable across our restarts and across HCM retries. If we crash mid-call, the next reconciler invocation queries HCM with the same key and sees the existing transaction (if HCM applied it).
2. **The HCM contract honors idempotency keys** (TRD §13). Real adapters that don't natively honor them must synthesize this guarantee via a follow-up query.
3. **The `ReconciliationStep` log** captures every step we took. On restart we resume from the last step; we never re-issue an HCM call that already had a recorded `HCM_CALL_IN_FLIGHT` entry without first checking the history.

**Exactly-once at the system boundary.** Combined: each provisional action causes at most one HCM debit/credit. Whether that debit happens on our first call or is detected via history query, the action is reconciled exactly once. The `ReconciliationStep` row makes this verifiable from the audit log without trusting our own memory.

**What if HCM never recovers?** The reconciler logs continued failures, and an alerting threshold (`provisionalActionStaleAlertMs`, default 4h) emits a high-severity audit event so operators are notified. Provisional actions accumulate; the `provisionalActions` GraphQL query exposes them to HR for manual review.

**Audit chain.** From any `PROVISIONALLY_APPROVED → APPROVED` transition, you can walk back through: `AuditEvent(PROVISIONAL_APPROVAL_CONFIRMED) → ReconciliationStep(OUTCOME_APPLIED) → ReconciliationStep(HCM_CALL_IN_FLIGHT or HCM_HISTORY_QUERIED) → AuditEvent(BREAK_GLASS_APPROVAL_INVOKED) → ProvisionalAction.localStateSnapshot`. Every transition is reproducible.

#### 9.5.4 Provisional cancellation flow (asymmetric)

Cancellation is a credit operation; the risk of being wrong is bounded (at worst, we credit and HCM hasn't actually debited yet, which converges naturally). Therefore: **provisional cancellation requires no break-glass role and no minimum outage threshold.** The mutation does, however, require the caller to set `acknowledgedHcmUnavailable: true` so the UI's warning contract is explicit (Q.α).

```
cancelTimeOffRequest when HCM unavailable AND request was APPROVED:
  │
[1] BEGIN TX:
      Insert ProvisionalAction {
        type: PROVISIONAL_CANCELLATION,
        requestId,
        invokedBy: actorId,
        invokedAt: now,
        reason: "user-initiated; acknowledgedHcmUnavailable=true",
        outageStartObservedAt: HcmHealthMonitor.outageStartedAt,
        localStateSnapshot: { balance, request, employment, leaveTypeAvail },
        reconciliationState: PENDING
      }
      Set request.state = CANCELLATION_PENDING
      (Note: not CANCELLED yet — still requires reconciliation.)
      Insert AuditEvent (action=PROVISIONAL_CANCELLATION_INVOKED,
        actor: actorId, acknowledgmentFlag: true)
    COMMIT
[2] Provisional reconciler (§9.5.3) drains this action on HCM recovery,
    using the same exactly-once algorithm: pre-flight history query, then
    releaseBalance with idempotencyKey = action.id, then result applied.
[3] If HCM has no record of the original debit (because the original
    approval was provisional and HCM later rejected it, or because the
    original debit went through but cancellation came later — both
    distinguishable via the history query): mark
    ProvisionalAction.reconciliationState = NO_OP if there is nothing
    for HCM to credit. The audit log retains the cancellation invocation
    AND the reconciliation outcome.
```

**Pair coalescing (Q.ζ).** If a request is approved provisionally and then cancelled provisionally during the same outage window, the reconciler's pair-coalescing pass (§9.5.3 step [1]) detects this and marks BOTH `ProvisionalAction` rows as `NO_OP` without issuing HCM calls. The request state advances directly to `CANCELLED`. The audit chain preserves both invocations, the pair-coalescing decision (`PROVISIONAL_PAIR_COALESCED` audit event), and the final state.

**Pair-coalescing rules (full set; documented for clarity):**

| Action A (earlier) | Action B (later, same request) | Coalescing outcome | HCM calls | Final state |
|---|---|---|---|---|
| BREAK_GLASS_APPROVAL | PROVISIONAL_CANCELLATION | Both → NO_OP | None | CANCELLED |
| PROVISIONAL_CANCELLATION | (no later opposing) | Reconcile individually | 1 release | CANCELLED (or NO_OP if no HCM debit) |
| BREAK_GLASS_APPROVAL | (no later opposing) | Reconcile individually | 1 reserve | APPROVED or ESCALATED_TO_HR |
| Two BREAK_GLASS_APPROVALs same request | — | Second is illegal (state guard prevents it) | n/a | n/a |
| Two PROVISIONAL_CANCELLATIONs same request | — | Second is idempotent NO_OP | n/a | already CANCELLED |

**Why coalesce.** It's both an optimization (fewer HCM calls) and a correctness mechanism: the alternative (issue reserve, then immediately release) is correct only if HCM honors both with matching transaction history — which we'd verify, but it's wasted work and creates more rows in HCM's transaction log than necessary. Coalescing avoids the round-trip; pre-flight history query ensures it's safe.

**Audit chain preservation (Q.ζ requirement).** All actions remain logged. Pair coalescing does not delete or hide any `ProvisionalAction` row — both rows persist with `reconciliationState = NO_OP`, and a `PROVISIONAL_PAIR_COALESCED` audit event ties them together with the decision rationale. The full history is auditable from the request_id.

#### 9.5.5 Provisional approval where leave date has passed

If `now > request.endDate` and the request is still `PROVISIONALLY_APPROVED` (HCM was down throughout the leave period), the leave was effectively taken on trust. This is the worst case for break-glass; the design handles it explicitly.

**Algorithm.** The reconciler still attempts to debit HCM (the employee's leave is real, and HCM should reflect it). The outcome dictates the final state:

- **HCM accepts:** request transitions `PROVISIONALLY_APPROVED → APPROVED → TAKEN` in the same reconciliation pass. `hrReviewFlag = false`. Audit-logged. Normal terminal state.
- **HCM rejects:** request transitions `PROVISIONALLY_APPROVED → TAKEN` with `hrReviewFlag = true` and `hrReviewReason = "Leave was taken under provisional approval; HCM rejected reconciliation. HR must determine resolution."`. This is the path where the leave happened but HCM disagrees — software cannot fix it; HR must.

**Why `TAKEN` and not `ESCALATED_TO_HR` in the leave-already-happened case (Q.β decision).**

We considered three alternatives:

1. **(Chosen)** Transition to `TAKEN` with `hrReviewFlag`. The state machine reflects what actually happened in the real world (the employee took the leave). The flag surfaces the irregularity to HR via the HR Review Queue.
2. Prevent the transition until reconciliation. The cron that would advance to `TAKEN` would block. *Rejected:* this is fiction — the leave happened regardless of what our state machine says.
3. Use a distinct `TAKEN_UNRECONCILED` state. *Rejected:* would split TAKEN into two states for dashboarding, but the `hrReviewFlag` on `TAKEN` accomplishes the same surfacing with less state-machine complexity. If a future product requirement needs the distinct state, splitting later is a low-risk refactor.

**Trade-off.** Option (1) means `TAKEN` is not strictly "happy terminal" — it can carry a flag. We document this loudly so dashboard and reporting code does not assume `TAKEN` means "everything went fine." The flag and HR Review Queue make the cases distinguishable for any consumer that cares.

**HR review surface (Q.β requirement).** Three categories of request require HR attention:

1. `state = ESCALATED_TO_HR` — HCM rejected a provisional approval before the leave date.
2. `state = TAKEN` AND `hrReviewFlag = true` — provisional approval rejected after the leave was taken.
3. `state = CANCELLATION_PENDING` for longer than `cancellationPendingAlertThresholdMs` — cancellation stuck.

These surface via the GraphQL query `hrReviewQueue` (§7) and as the audit-event stream `HR_REVIEW_REQUIRED`. The internal HR-facing UI is product-team's responsibility; the data is exposed by this service.

#### 9.5.6 Stale-provisional-action alerting (Rev 3.1, Q.λ)

A `ProvisionalAction` row that has been in `PENDING` state for longer than `provisionalActionStaleAlertMs` (default 4h, configurable) is considered stale — either HCM has remained unreachable for an unusually long time, or the reconciler has failed to make progress for some other reason. Both cases require operator attention.

The reconciler emits two signals on every tick when it observes stale actions:

1. **Audit event** — `PROVISIONAL_ACTION_STALE` with severity HIGH, including the action ID, age in milliseconds, the most recent `ReconciliationStep` (if any), and current HCM health status. One event per stale action per tick (idempotent within a tick window via a `lastStaleAlertAt` timestamp on the action row).
2. **Metric counter** — `reconciler.staleAlertMetricName` (default `provisional_action_stale_count`), a gauge whose value is the current count of stale pending actions. Tagged by `outage_age_bucket` (e.g., `<1h`, `1-4h`, `4-12h`, `>12h`). Updated on every reconciler tick.

**Why both.** Audit events are preserved durably for HR review and incident reconstruction; they tell us *what* happened. Metrics are sampled by ops dashboards and trigger pagerduty/alerting integration; they tell us *what is happening right now*. Separating these concerns lets HR see the full history and lets ops respond to fires without grepping audit logs.

**Why a gauge and not a counter.** A counter accumulates and never decreases. A gauge reflects the current state — when the reconciler drains stale actions, the gauge drops, which is what an ops dashboard wants to see. Audit events take care of the historical record.

**Out-of-scope.** The actual alerting integration (PagerDuty, Slack, email) is product/ops responsibility and is intentionally out of scope (boundary in §19.3). This TRD specifies the signals the system emits; downstream wiring is configuration.

#### 9.5.7 Manager-in-the-loop guarantee

No request transitions to `APPROVED` or `PROVISIONALLY_APPROVED` without an explicit approval call from a designated approver. The auth boundary tags each call with `actorId`; self-approval (`actorId == employeeId`) is rejected. The break-glass role is a strict superset of the regular approver role.

## 10. Synchronization with HCM

### 10.1 Inbound: realtime webhook

HCM POSTs events to a dedicated internal endpoint. Handler validates HMAC signature (using `crypto.timingSafeEqual`), inserts into `InboxEvent` (deduplicated on `eventId`), returns 2xx immediately. Inbox processor (polling worker) consumes asynchronously.

**Ordering authority.** `hcmVersion` is the only ordering authority. `appliedAt` is HCM's wall clock and is informational only (used in audit logs for human readability, never in comparisons or version checks). If a webhook arrives with `appliedAt` in our future (clock skew), we still accept it provided `hcmVersion > current.hcmVersion`. This protects against clock-skew failures.

Event types: `BALANCE_UPDATED`, `EMPLOYMENT_CHANGED`, `LEAVE_TYPE_CHANGED`, `EMPLOYEE_CREATED` (new — triggers bootstrap, see §11).

### 10.2 Inbound: batch reconciliation

Daily cron pulls full HCM balance dump via cursor-paginated batch endpoint. For each row: compare `hcmVersion`, apply if newer, classify divergence (`ANNIVERSARY_BUMP`, `ANNUAL_REFRESH`, `MISSED_WEBHOOK`, `RETRO_CORRECTION`, `UNKNOWN_DRIFT`), audit-log the classification. Also catches new employees missed by webhooks (§11.4).

### 10.3 Outbound: outbox to HCM

Outbox entries claimed by single worker. Polling interval default 1s, configurable. Entry types now include `BOOTSTRAP_EMPLOYEE` and `RECONCILE_PROVISIONAL` in addition to the original `RESERVE_BALANCE`, `RELEASE_BALANCE`, `FETCH_BALANCE`.

### 10.4 Post-commit point-read (updated: jitter and coalescing)

After a `SUCCEEDED` outbox entry, a point-read of the same balance is scheduled. Two mechanisms work together to prevent a thundering herd:

**Jitter.** Schedule at `commit_time + pointReadDelayMs + uniform(0, pointReadJitterMs)`. Defaults: delay 30s, jitter 5s. This spreads load across a window even when commits are correlated in time.

**Coalescing.** The point-read scheduler maintains an in-memory map of `(employeeId, locationId, leaveTypeId) → earliestScheduledAt`. When a new point-read is requested for a balance that already has one scheduled, the request is dropped (we'll learn the truth from the already-scheduled read). When a point-read fires, its entry is removed from the map.

**Steady-rate drain.** A separate component drains the scheduler at a configurable rate (`pointReadMaxRatePerSecond`, default 10). Reads that would exceed the rate are deferred to the next second. This bounds HCM call volume regardless of input burst rate.

**Why both?** Jitter alone addresses time-correlation but doesn't bound rate. Coalescing alone addresses duplicate reads but doesn't help when 1000 distinct balances all need verification. Both are needed; each guards against a different failure mode.

The point-read remains the third defensive layer (§13.4): after schema validation and transaction confirmation, we verify HCM's current view matches ours. Coalescing has zero risk of missing drift because each balance still gets read; only redundant reads of the same balance are dropped.

## 11. Employee Bootstrap

This section is new in Revision 2.

### 11.1 Why bootstrap matters

The system can only operate on employees for whom it has projected data (`Employee` row plus initial `Balance`, `Employment`, `LeaveTypeAvailability` rows). For a new hire, none of these exist until HCM tells us. Without an explicit bootstrap flow, the first interaction with that employee would fail with `LEAVE_TYPE_NOT_AVAILABLE` or worse.

### 11.2 Primary path: webhook-driven bootstrap

HCM emits an `EMPLOYEE_CREATED` event when a new employee is hired (or otherwise made known to HCM for this tenant). The inbox processor:

```
[1] Receive EMPLOYEE_CREATED event.
[2] BEGIN TX:
      Insert Employee row { employeeId, bootstrappedAt: now, source: WEBHOOK }
      Insert Employment row from event payload.
      Trigger immediate sync of balances and leave-type availability
      (via outbox BOOTSTRAP_EMPLOYEE entries, processed asynchronously).
    COMMIT
[3] Emit AuditEvent (action=EMPLOYEE_BOOTSTRAPPED, source=WEBHOOK).
```

This is the happy path. It scales — webhook-driven means we learn about new employees in seconds.

### 11.3 Safety-net path: lazy bootstrap on first touch

The webhook path has dependencies (HCM emits the webhook, our endpoint receives it, the inbox processor runs). Any failure leaves us without the bootstrap. So we also lazily bootstrap on first touch.

When any API operation references an `employeeId` we don't have:

```
[1] Synchronously call HCM:
    - fetchEmployment(employeeId)
    - fetchBalances(employeeId)
    - fetchLeaveTypes(employee's current location)
[2] If HCM returns 404 or equivalent: return EMPLOYEE_NOT_BOOTSTRAPPED.
    The employee genuinely doesn't exist in HCM; we can't help.
[3] If HCM returns data:
    BEGIN TX:
      Insert Employee { source: LAZY_PULL }
      Insert Employment rows
      Insert Balance rows
      Verify LeaveTypeAvailability for the employee's location is current
      (if not, refresh that too)
      Insert AuditEvent (action=EMPLOYEE_BOOTSTRAPPED, source=LAZY_PULL)
    COMMIT
[4] Proceed with the original operation.
```

If HCM is unavailable during lazy bootstrap, the original operation fails with `HCM_UNAVAILABLE`. We do not bootstrap an employee from local guesses; that would violate ADR-001 (HCM is dispositive).

### 11.4 Tertiary path: batch reconciliation

The daily batch dump includes all employees. New rows in the dump that have no corresponding `Employee` are bootstrapped using batch as the source (`bootstrapSource = BATCH`). Worst-case latency for a new employee whose webhook was lost and who never used the system: 24 hours.

### 11.5 Why three paths?

- **Webhook** is fast but lossy (network failures, our outages, HCM bugs).
- **Lazy pull** is correct but only triggers on actual employee activity.
- **Batch** is the unconditional safety net.

Same layered-defense philosophy as the rest of the system: any one path can fail and the others still converge correctly.

### 11.6 EmployeeBootstrapService

Encapsulates all three paths behind one service:

```
EmployeeBootstrapService {
  bootstrapFromWebhook(event: EmployeeCreatedEvent): Promise<void>;
  bootstrapLazy(employeeId: string): Promise<Employee>;
  bootstrapFromBatch(row: BatchEmployeeRow): Promise<void>;
  ensureBootstrapped(employeeId: string): Promise<Employee>;  // checks + lazy-pulls if needed
}
```

`ensureBootstrapped` is called at the entry of every employee-referencing operation. Idempotent: if the employee already exists, fast no-op.

## 12. Location Transfers

This section is mechanically unchanged from Revision 1; the integration with new states is documented inline.

### 12.1 Data model

Unchanged: `Employment` timeline + `Employment.locationAt(date)`. `LeaveTypeAvailability` per-location.

### 12.2 Location attribution at request submission

`locationId = Employment.locationAt(input.startDate)`. The employee never picks the location directly.

### 12.3 Disallowed: requests spanning a transfer

`Employment.locationAt(startDate) ≠ Employment.locationAt(endDate)` → `REQUEST_SPANS_LOCATION_TRANSFER`.

### 12.4 Location change while a request is pending

`EMPLOYMENT_CHANGED` inbox event → for each `PENDING_APPROVAL` or `PROVISIONALLY_APPROVED` request, recompute `locationAt(request.startDate)`. If different from `request.locationId`:

- Mark `NEEDS_REVALIDATION`.
- Verify new `(loc, leaveType)` exists in `LeaveTypeAvailability`.
- If valid: rebalance holds across old and new `(emp, loc, type)` rows. For `PROVISIONALLY_APPROVED`, the `provisionalHold` moves to the new location.
- If invalid: reject with `LEAVE_TYPE_NOT_AVAILABLE_AT_NEW_LOCATION`. For `PROVISIONALLY_APPROVED`, this additionally escalates to HR (the request was provisionally approved on the assumption it would clear at the old location).

### 12.5 Location change after approval

Approved requests: no change. The approval correctly attributed at approval time. HCM-driven post-approval reattribution handled via paired BALANCE_UPDATED events (credit old, debit new).

### 12.6 Leave type variability across locations

`LeaveTypeAvailability` consulted at submission, revalidation, and reconciliation. Tests cover the matrix.

### 12.7 Transfer-specific edge cases

Numbered with the master enumeration (§15).

## 13. Defensive Strategy Against Unreported HCM Errors

Five layers, plus the new sixth layer for provisional reconciliation.

### 13.1 Local pre-validation (cheap filter)

Before any HCM call: dimension validity, dates, units, idempotency. Most invalid requests never reach HCM.

### 13.2 Strict HCM response validation

Required HCM contract on every mutation response:

```typescript
interface HcmMutationResponse {
  transactionId: string;       // unique, idempotent on retries
  deltaApplied: Decimal;       // actual delta (negative for debit)
  newAvailable: Decimal;
  hcmVersion: bigint;          // strictly greater than pre-call
  appliedAt: ISOTimestamp;     // informational only (§10.1)
}
```

Validation rules (zod-enforced):
- Schema strict; missing fields → `HCM_RESPONSE_INVALID`.
- `deltaApplied` equals requested delta (configurable tolerance per leave type, default zero).
- `hcmVersion` strictly greater than our last known version.
- `transactionId` not previously seen.

**Why `deltaApplied`?** Anniversary bumps and concurrent updates from other systems can land between our read and HCM's commit. `deltaApplied` is HCM's report of what *its* operation did, independent of concurrent activity. This is the only sound formulation.

### 13.2.1 HCM transaction history query (Q.γ — required for provisional reconciler)

The HCM contract must also support a transaction-history query, used by the provisional reconciler to verify exactly-once execution across our restarts:

```typescript
interface HcmTransactionQuery {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  idempotencyKey?: string;       // filter to transactions with this key
  window?: { start: ISO; end: ISO };
}

interface HcmTransactionRecord {
  transactionId: string;
  idempotencyKey?: string;       // populated if HCM stores client-supplied keys
  deltaApplied: Decimal;
  appliedAt: ISO;
  hcmVersion: bigint;
}

HcmPort.queryTransactions(query): Promise<HcmTransactionRecord[]>
```

**Adapter responsibility.** If a real vendor doesn't natively support keyed history queries, the adapter must synthesize the lookup via a per-tenant transaction log fetch. If the vendor exposes neither, that adapter is flagged as "best-effort exactly-once" and the system falls back to layer-13.5 reconciliation to detect double-application. The mock HCM implements `queryTransactions` natively.

### 13.3 Transaction-confirmation cross-check

For `RESERVE_BALANCE` requesting `-N`: valid response shows `deltaApplied == -N`. `deltaApplied == 0` while requested non-zero → `SUSPECT_NO_OP`. `deltaApplied != requestedDelta` → `HCM_RESPONSE_INVALID`.

### 13.4 Deferred point-read

With jitter and coalescing (§10.4). Catches any discrepancy schema validation missed.

### 13.5 Reconciliation backstop

Three cadences: continuous (point-read), periodic drift sweep (hourly), full batch (daily). All configurable.

### 13.6 Provisional reconciliation pass

The provisional reconciler (§9.5.3) is a sixth layer specific to break-glass actions. It is the final guarantee that even decisions made without live HCM are eventually reconciled and either confirmed by HCM or escalated to HR with full context.

### 13.7 Combined effect

For undetected drift to persist beyond 24 hours, all six layers must fail simultaneously. Any one layer functioning catches the issue.

## 14. Error Taxonomy, Idempotency, Decimals

### 14.1 Idempotency keys

Two layers:

1. **Inbound (client → us).** Required on every mutation. Stored in `IdempotencyKey` with full response snapshot. TTL configurable (default 7 days).
2. **Outbound (us → HCM).** Generated per outbox entry. Stable across retries (so HCM can deduplicate). For provisional reconciliation, the key is the `ProvisionalAction.id` — stable across both retries and our restarts.

### 14.2 Resolution flow

1. Compute `inputHash = sha256(canonicalize(input))` per §14.4.
2. Lookup `IdempotencyKey` by `key`.
3. **Found, hash matches:** return stored `responseSnapshot` (no side effects).
4. **Found, hash differs:** return `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`.
5. **Not found:** insert `(key, hash, ...)` atomically with the mutation. Snapshot the response.

### 14.3 Canonical Input Serializer (new — §14.4 below specifies)

### 14.4 Canonical Input Serializer specification

`canonicalize(input)` must reduce semantically-equivalent inputs to byte-identical output. Rules:

1. **Field ordering.** Object keys sorted lexicographically. Nested objects recursively.
2. **Whitespace.** No whitespace in serialized output (no pretty-printing). Strings themselves preserve internal whitespace.
3. **Unicode.** All strings normalized to NFC (Normalization Form Canonical Composition) before serialization. This prevents `é` (single codepoint) from differing from `é` (e + combining accent).
4. **Dates.** All date inputs parsed to a `Date` object and re-serialized as ISO-8601 with `Z` timezone (UTC). Inputs in any of `"2025-01-15"`, `"2025-01-15T00:00:00Z"`, `"2025-01-15T00:00:00.000Z"` all collapse to `"2025-01-15T00:00:00.000Z"`. Date-only fields (start/end) drop time entirely: `"2025-01-15"`.
5. **Decimals.** All decimal inputs parsed via `new Decimal(x)` (decimal.js) and re-serialized via `.toFixed(precision)` where `precision` is determined by the leave type's configured precision (default 2 — half-day granularity is 0.5 = "0.50"). Numeric inputs `2`, `2.0`, `"2"`, `"2.00"` all collapse to `"2.00"`.
6. **Booleans, nulls.** Serialized as JSON literals.
7. **Arrays.** Preserve order (semantically meaningful), but each element canonicalized recursively.
8. **Unknown / extra fields.** Stripped before hashing — only declared input fields are canonicalized. Prevents future schema additions from invalidating past keys.
9. **Hash.** SHA-256 of canonical bytes, hex-encoded.

Why this matters: a client retrying a mutation may produce subtly different bytes for the same semantic input (e.g., reordered fields, different decimal representation). Without canonicalization, we'd treat the retry as a new request (or worse, the *original* request as a different one). With canonicalization, retries are correctly deduplicated.

All four ambiguities (dates, decimals, ordering, Unicode) have dedicated tests in the test plan (§17 of `03_Test_Plan.md`).

### 14.5 Decimal handling

We use `decimal.js` throughout for all units and balance arithmetic. Rationale:

- JavaScript's native `number` is IEEE 754 binary float. `0.1 + 0.2 !== 0.3`. Unacceptable for financial-grade quantities.
- `decimal.js` is well-maintained, widely used, and has the operator-method API natural for this domain.
- Alternatives `big.js` (less feature-complete) and `bignumber.js` (similar to decimal.js, slightly different API) considered; decimal.js is the most ergonomic for our needs.

**Serialization rules.**

- **GraphQL:** custom `Decimal` scalar. Serialized as a string (`"2.50"`) to avoid JSON-number precision loss. Parsed via `new Decimal(input)` on receipt.
- **SQLite:** stored as `TEXT` (string) in canonical form (matching the leave type's precision). On read, parsed back via `new Decimal(text)`. Comparisons use `.cmp()`, never `==`.
- **HCM contract:** the port's response schema validates Decimal fields as strings; the adapter parses to `Decimal` before returning to domain code.

This avoids ever round-tripping a Decimal through `number`.

### 14.6 Error taxonomy (full)

| Code | Meaning | Retryable | Surface |
|---|---|---|---|
| `INSUFFICIENT_BALANCE_LOCAL` | Local pre-check failed (advisory) | No | Create only |
| `INSUFFICIENT_BALANCE_HCM` | HCM rejected for balance | No | Create, Approve, Provisional reconcile |
| `INVALID_DIMENSION` | `(emp, loc, type)` not valid in HCM | No | Create, Approve |
| `INVALID_DATES` | Range invalid, end<start, units=0 | No | Create |
| `STATE_TRANSITION_NOT_ALLOWED` | Illegal state transition | No | All mutations |
| `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT` | Key collision | No | All mutations |
| `BALANCE_UNDER_RECONCILIATION` | Active reconciliation locked the row | Yes | Create, Approve |
| `HCM_UNAVAILABLE` | HCM unreachable / 5xx | Yes | Create (warn), Approve (fail) |
| `HCM_RESPONSE_INVALID` | Schema or semantic validation failed | Yes | Internal |
| `POLICY_VIOLATION` | E.g., advance leave when disallowed (UX hint only) | No | Create |
| `REQUEST_SPANS_LOCATION_TRANSFER` | Range crosses Employment boundary | No | Create |
| `LEAVE_TYPE_NOT_AVAILABLE_AT_NEW_LOCATION` | Post-transfer revalidation failed | No | Internal |
| `EMPLOYMENT_NOT_FOUND` | No active employment for date | No | Create |
| `LEAVE_TYPE_NOT_AVAILABLE` | Leave type not active at location | No | Create |
| `REQUEST_NOT_FOUND` | Bad ID | No | All non-create mutations |
| `TERMINAL_STATE_REACHED` | E.g., cancelling a TAKEN req | No | Cancel |
| `BREAK_GLASS_NOT_AUTHORIZED` | Caller lacks break_glass_approver role | No | approveProvisionally |
| `BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET` | HCM unavailable for < min outage | No | approveProvisionally |
| `PROVISIONAL_RECONCILIATION_REJECTED` | Internal: HCM rejected provisional on recovery | n/a | Internal (escalation) |
| `PROVISIONAL_RECONCILIATION_TRANSIENT_FAILURE` | Internal: HCM transient failure during reconcile; will retry | Yes | Internal |
| `PROVISIONAL_RECONCILIATION_ALREADY_RECONCILED` | Internal: caller attempted to reconcile an already-terminal action | No | Internal |
| `EMPLOYEE_NOT_BOOTSTRAPPED` | Employee unknown, lazy pull failed | No | Create |
| `CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT` | Cancellation of APPROVED request during HCM outage missing the `acknowledgedHcmUnavailable: true` field | No | Cancel |
| `HR_REVIEW_REQUIRED` | Marker on TAKEN+hrReviewFlag and on ESCALATED_TO_HR requests; surfaces via hrReviewQueue | n/a | Read (informational) |
| `EMPLOYEE_NOT_FOUND_AT_HCM_DURING_RECONCILIATION` | Rev 3.1 (Q.ν): HCM has no record of the employee when the reconciler queries — employee deleted between break-glass invocation and reconciliation | n/a | Internal (escalation, surfaces via hrReviewQueue) |

Each error has at least one test (§14 of `03_Test_Plan.md`).

## 15. Edge Cases (enumerated)

Numbered for traceability with tests. Revision 2 extends the list to 67 cases.

### Concurrency
1. Two concurrent approvals for same employee → HCM serializes; one approves, one INSUFFICIENT_BALANCE_HCM.
2. Concurrent create + approve → no overlap.
3. Concurrent cancel + approval → state machine guards.

### HCM defensive
4. HCM 200, no transaction confirmation → HCM_RESPONSE_INVALID.
5. HCM 200, deltaApplied=0 while requested ≠ 0 → SUSPECT_NO_OP.
6. HCM 200, wrong delta → HCM_RESPONSE_INVALID.
7. HCM 200, stale hcmVersion → HCM_RESPONSE_INVALID.
8. HCM 5xx → retry.
9. HCM timeout, request actually applied → retry returns prior result.
10. HCM malformed JSON → HCM_RESPONSE_INVALID.

### HCM-side concurrent updates
11. Anniversary bump mid-approval → balance rises via webhook; approval still succeeds.
12. Year-start refresh thundering herd → batch processing handles.
13. Retro correction drops balance below holds → UNDER_HOLD_DEFICIT; requests NEEDS_REVALIDATION.

### State machine
14. Approve a non-PENDING_APPROVAL request → STATE_TRANSITION_NOT_ALLOWED.
15. Cancel a TAKEN request → TERMINAL_STATE_REACHED.
16. Self-approval → rejected at boundary.
17. Double-approval same key, same input → returns prior response.
18. Double-approval same key, different input → IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT.

### Location
19. Request submitted for date after known transfer → uses new location.
20. Transfer arrives while request pending → NEEDS_REVALIDATION; auto-resolves if compatible.
21. Request spans transfer date → REQUEST_SPANS_LOCATION_TRANSFER.
22. Transfer to incompatible location → LEAVE_TYPE_NOT_AVAILABLE_AT_NEW_LOCATION.
23. Withdrawn transfer (HCM correction) → request reverts.
24. Approved request unaffected by post-approval transfer.
25. HCM-driven reattribution via paired events.

### Inbound webhooks
26. Out-of-order webhooks → discarded by version check.
27. Duplicate webhook → deduplicated.
28. Webhook for unknown employee → triggers bootstrap if EMPLOYEE_CREATED, else logged and ignored.
29. Malformed webhook → 4xx, logged.
30. Bad signature → 401, logged.
31. Webhook flood → inbox absorbs; processor drains.

### Reconciliation
32. Batch + realtime racing → version check protects.
33. Reconciler finds drift → applies HCM truth; classifies divergence.
34. Reconciler running with outbox in flight → no conflict.
35. New leave type in batch → LeaveTypeAvailability created.
36. Leave type disappears → marked inactive; pending revalidated.

### Data model
37. Negative balance within UX tolerance → allowed (HCM is dispositive).
38. Negative balance beyond tolerance → still allowed if HCM accepts; tolerance is UX hint only.
39. Decimal precision mismatch → input rejected at validation.
40. Units = 0 → INVALID_DATES.
41. End < start → INVALID_DATES.

### Cancellation
42. Cancel PENDING_APPROVAL → local-only.
43. Cancel APPROVED with HCM available → standard saga.
44. Cancel APPROVED during HCM outage → provisional cancellation, retry, alert.
45. Cancel of already-cancelled → idempotent return.

### Crash recovery
46. Crash after DB, before outbox dispatch → outbox persists.
47. Crash during HCM call → idempotency key replays.
48. Crash during reconciliation → idempotent restart.

### Break-glass (new)
49. Break-glass attempted with HCM available → HCM_UNAVAILABLE-not-met error.
50. Break-glass attempted, outage < threshold → BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET.
51. Break-glass attempted, threshold met, role missing → BREAK_GLASS_NOT_AUTHORIZED.
52. Break-glass success → PROVISIONALLY_APPROVED with full audit.
53. Break-glass success, HCM recovers, reconciles to APPROVED → request transitions cleanly.
54. Break-glass success, HCM recovers, reconciles to ESCALATED_TO_HR → audit trail intact.
55. Break-glass success, leave taken before HCM recovers, HCM accepts → PROVISIONALLY_APPROVED → APPROVED → TAKEN.
56. Break-glass success, leave taken before HCM recovers, HCM rejects → ESCALATED_TO_HR with severity flag.
57. Break-glass success, employee cancels before reconciliation → PROVISIONALLY_APPROVED → CANCELLED via provisional cancellation path; both ProvisionalActions resolve correctly.
58. Provisional cancellation of APPROVED request during outage → CANCELLATION_PENDING; outbox retries; eventual CANCELLED.
59. Provisional cancellation, HCM rejects credit (rare) → audit + manual escalation.
60. Cancellation pending alert fires after threshold → audit event.

### Bootstrap (new)
61. New employee submits request, webhook hasn't arrived → lazy pull succeeds.
62. New employee submits request, HCM unavailable, no webhook → EMPLOYEE_NOT_BOOTSTRAPPED.
63. New employee in batch dump only → bootstrapped overnight; works next day.
64. Webhook race: webhook arrives during lazy pull → both transactions safe (insert ignored if exists).

### Canonicalization (new)
65. Same key, fields in different order → recognized as same input.
66. Same key, decimal `2` vs `2.0` vs `"2.00"` → recognized as same.
67. Same key, Unicode NFC vs NFD → recognized as same.

### Provisional reconciler — exactly-once and event log (new in Rev 3, Q.γ)
68. Pre-flight history query reveals existing HCM transaction with matching key + delta → reconciler skips reserve/release; marks CONFIRMED based on existing transaction.
69. Pre-flight history query reveals existing transaction with matching key but mismatched delta → action marked REJECTED_ESCALATED; full audit chain via ReconciliationStep.
70. Pre-flight history query returns nothing → reconciler proceeds to reserve/release with action.id as key.
71. Reconciler crashes after HCM_HISTORY_QUERIED, before HCM_CALL_IN_FLIGHT → on restart, repeats history query (cheap, idempotent), then proceeds. ReconciliationStep log shows both history queries; second is the authoritative one.
72. Reconciler crashes after HCM_CALL_IN_FLIGHT, before OUTCOME_APPLIED → on restart, history query reveals the transaction HCM applied; reconciler treats it as if the call had returned, applies outcome.
73. Reconciler runs twice concurrently due to race → advisory lock prevents both from proceeding; the second skips this tick.
74. ReconciliationStep cannot be inserted (storage error) → reconciler logs and retries; never proceeds without the step row.

### Pair coalescing (new in Rev 3, Q.ζ)
75. Provisional approval followed by provisional cancellation, same outage → both NO_OP at coalescing pass; CANCELLED state; ReconciliationStep records PAIR_COALESCED for both.
76. Two provisional cancellations on the same request → second is recognized as idempotent NO_OP; first is reconciled normally.
77. Provisional approval followed by provisional approval on the same request → state guard rejects the second at API layer.

### Q.α — Cancellation acknowledgment contract
78. Cancel APPROVED during HCM outage WITHOUT `acknowledgedHcmUnavailable: true` → CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT error; client retries with flag set. Audit logs both attempts.

### Rev 3.1 additions

79. **Employee deleted at HCM between break-glass and reconciliation (Q.ν):** Break-glass approval invoked while HCM unavailable; HCM recovers; reconciler's pre-flight history query returns `EMPLOYEE_NOT_FOUND`. Reconciler transitions the request to `ESCALATED_TO_HR` with `hrReviewReason = "Employee no longer exists in HCM"`; `EMPLOYEE_NOT_FOUND_AT_HCM` ReconciliationStep recorded; surfaces in HR Review Queue.
80. **History-query window exclusion (Q.κ):** A transaction that HCM applied *outside* the configured `historyQueryWindowMs` window (e.g., a late-arriving manual replay) is not seen by the reconciler. Reconciler proceeds to issue a new HCM call with the same idempotency key; HCM's own deduplication takes over. Tested explicitly: window default of 24h is wide enough to catch all reconciler-initiated activity, narrow enough to bound query work.

## 16. Configuration

All knobs typed via NestJS `ConfigService`. Tested as a concern.

```typescript
interface ServiceConfig {
  hcm: {
    baseUrl: string;
    timeout: number;
    healthCheckIntervalMs: number;        // default 5000
    healthRecoveryWindowMs: number;       // default 60000
  };
  outbox: {
    pollingIntervalMs: number;            // default 1000
    maxAttempts: number;                  // default 5
    baseBackoffMs: number;                // default 1000
    maxBackoffMs: number;                 // default 60000
    batchSize: number;                    // default 10
  };
  inbox: {
    pollingIntervalMs: number;            // default 1000
    batchSize: number;                    // default 50
  };
  reconciliation: {
    pointReadDelayMs: number;             // default 30000
    pointReadJitterMs: number;            // default 5000
    pointReadMaxRatePerSecond: number;    // default 10
    driftSweepIntervalMs: number;         // default 3600000
    fullBatchIntervalMs: number;          // default 86400000
    staleBalanceThresholdMs: number;      // default 300000
  };
  reconciler: {                           // Rev 3.1: provisional reconciler knobs
    provisionalIntervalMs: number;        // default 30000 (timer-based drain)
    historyQueryWindowMs: number;         // default 86400000 (24h) — Q.κ
    leaseTtlMs: number;                   // default 60000 — Q.ι
    provisionalActionStaleAlertMs: number;// default 14400000 (4h) — Q.λ
    staleAlertMetricName: string;         // default 'provisional_action_stale_count' — Q.λ
    snapshotRetention: {
      summarizeAfterSuccess: boolean;     // default true — Q.θ
      retainFullSnapshotForEscalated: boolean; // default true
    };
  };
  idempotency: {
    keyTtlMs: number;                     // default 604800000 (7d)
  };
  breakGlass: {
    minOutageMs: number;                  // default 60000
    requireRole: string;                  // default 'break_glass_approver'
  };
  cancellation: {
    pendingAlertThresholdMs: number;      // default 3600000 (1h)
  };
  policy: {
    // UX HINT ONLY: tolerance for showing "this would go negative" warnings.
    // HCM is dispositive; this is not enforcement.
    advanceLeaveToleranceUnits: Record<LeaveTypeId, Decimal>;
    leaveTypePrecision: Record<LeaveTypeId, number>;   // decimal places
  };
}
```

**`policy.advanceLeaveToleranceUnits` is a UX hint only.** Local pre-checks may use it to surface "you're going negative, are you sure?" prompts. The actual decision is HCM's. Configuration tests verify that changing this value affects warnings, not approvals.

**`reconciler.historyQueryWindowMs` (Rev 3.1, Q.κ).** Default 24 hours. Rationale: wider than any plausible reconciler delay between break-glass invocation and the actual reconciliation tick, and wider than HCM's typical clock skew. Narrow enough that unrelated transactions in the same dimension don't appear in results — and the idempotency-key filter narrows further regardless. A multi-day HCM outage means break-glass actions from 25 hours ago would be reconciled outside the window; the system still works correctly (HCM's own idempotency-key handling catches duplicates), but the audit chain is less clean. Operators with longer expected outages should widen this.

**`reconciler.leaseTtlMs` (Rev 3.1, Q.ι).** Default 60 seconds. Any tick longer than this is anomalous. The TTL is intentionally short so a crashed worker doesn't block reconciliation for long.

**`reconciler.snapshotRetention.summarizeAfterSuccess` (Rev 3.1, Q.θ).** Default true. Setting to false retains all snapshots in full (storage cost; useful only for compliance-heavy deployments).

Invalid config rejected at startup. Tests cover both valid and invalid loadings.

## 17. Mock HCM Server

### 17.1 Architecture

Separate NestJS application, deployable as own process. Embodies the contract real adapters must satisfy.

### 17.2 HTTP API (unchanged from Revision 1)

```
GET  /balances/:employeeId/:locationId/:leaveTypeId
POST /balances/reserve         (idempotent on Idempotency-Key header)
POST /balances/release         (idempotent)
GET  /balances/batch           (NDJSON cursor stream)
GET  /employment/:employeeId
GET  /leaveTypes/:locationId
GET  /employees/:employeeId    (for lazy bootstrap)
POST /admin/setBalance
POST /admin/setEmployment
POST /admin/setLeaveTypeAvailability
POST /admin/createEmployee     (triggers EMPLOYEE_CREATED webhook)
POST /admin/scheduleEvent
POST /admin/setMode
POST /admin/setReachability    (off / on with configurable failure type)
POST /admin/triggerWebhookFlood
GET  /admin/state              (full inspectable state for tests)
```

### 17.3 Adversarial modes

| Mode | Behavior |
|---|---|
| `normal` | Honest |
| `flaky` | Random 5xx and timeouts at configurable rate |
| `silent_no_op` | 200 with `deltaApplied = 0` |
| `wrong_delta` | 200 with `deltaApplied != requested` |
| `missing_confirmation` | 200 with confirmation fields omitted |
| `stale_version` | Returns `hcmVersion` ≤ current |
| `malformed` | Invalid JSON or wrong shape |
| `slow` | Adds N seconds latency |
| `version_skew` | Returns versions out of order |
| `unreachable` | Network errors / times out (for break-glass tests) |

### 17.4 Mock HCM persistence (new in Revision 2)

The Mock HCM uses its own SQLite database (separate from the service's database) for durable state. Rationale:

- **Crash-recovery tests need determinism.** When the service crashes mid-call, the test must verify whether HCM actually applied the change. With in-memory state, restarting the test framework would lose this information.
- **Cross-process E2E tests need durability across restarts.** Our service and the Mock HCM are separate processes; the Mock HCM may need to survive scenarios where the service restarts.
- **Asserting on HCM state is part of the test contract.** `GET /admin/state` lets tests verify HCM's view directly. Backing this with a real (small) SQLite makes the assertion semantically clean.

The Mock HCM's SQLite is recreated fresh per test fixture by deleting and re-migrating. In production-shaped tests (long-running E2E), persistence enables verifying state across multi-minute scenarios.

The Mock HCM itself is now non-trivial software. Tests verify the mock itself (§17 of `03_Test_Plan.md` — Layer 17: Mock HCM Internal Tests, added in Revision 2 specifically to catch mock bugs that would otherwise produce false confidence).

### 17.5 Outbound webhooks

Mock fires webhooks on internal balance changes (admin-driven or scheduled), employment changes, leave-type changes, and `EMPLOYEE_CREATED`. Configurable delivery delay, drop rate, duplicate rate, out-of-order rate, signature validity.

### 17.6 MockHcmTestHarness (new in Revision 3, Q.ε)

The mock has many degrees of freedom: state (balances, employment, leave types, employees, transactions), mode (nine adversarial modes), reachability (on/off with configurable failure type), scheduled events, webhook firing controls. If every test independently constructs HTTP calls to admin endpoints, three problems emerge:

1. **Setup duplication** — every test repeats the same boilerplate for reset + seed + mode set.
2. **Drift between tests** — small variations in setup produce flaky or false-positive results.
3. **Mock contract changes are everywhere** — adding a new admin endpoint means updating every test that touches the mock.

The `MockHcmTestHarness` centralizes all mock interaction behind a typed, documented helper:

```typescript
/**
 * Single entry point for all test interactions with the Mock HCM.
 *
 * Lifecycle:
 *   1. beforeAll: construct one harness instance; it owns the mock HTTP client.
 *   2. beforeEach: harness.reset() — clears mock SQLite, resets mode to `normal`,
 *      reachability to `on`, drains webhook queue.
 *   3. Test body: harness.seed(...), harness.setMode(...), harness.assertState(...).
 *   4. afterAll: harness.shutdown() — closes connections.
 *
 * Crash-recovery tests skip beforeEach.reset() between phases and use
 * harness.snapshot() / harness.restoreSnapshot() to control persistence
 * deliberately.
 */
class MockHcmTestHarness {
  // --- Lifecycle ---
  async reset(): Promise<void>                                          // clear + re-migrate mock DB
  async shutdown(): Promise<void>
  async snapshot(): Promise<MockHcmSnapshot>                            // full state for crash-recovery tests
  async restoreSnapshot(s: MockHcmSnapshot): Promise<void>

  // --- Seeding ---
  async seedBalance(emp, loc, type, available, hcmVersion?): Promise<void>
  async seedEmployment(emp, loc, effectiveFrom, effectiveTo?): Promise<void>
  async seedLeaveTypeAvailability(loc, type, isActive, effectiveFrom?): Promise<void>
  async seedEmployee(emp, employmentRows, balanceRows): Promise<void>
  async seedTransaction(tx: HcmTransactionRecord): Promise<void>        // for queryTransactions tests

  // --- Mode control ---
  async setMode(mode: MockMode): Promise<void>
  async setReachability(state: 'on' | 'off' | 'flaky', config?): Promise<void>

  // --- Event scheduling ---
  async scheduleBalanceUpdate(emp, loc, type, newAvailable, atDelay): Promise<void>
  async scheduleEmploymentChange(emp, oldLoc, newLoc, effective): Promise<void>
  async scheduleEmployeeCreated(emp, employmentRows): Promise<void>
  async triggerWebhookFlood(eventCount, perSecondRate): Promise<void>

  // --- Assertions (Q.γ matters here) ---
  async assertBalance(emp, loc, type, expected: { available, hcmVersion }): Promise<void>
  async assertTransactionExists(idempotencyKey, expectedDelta): Promise<void>
  async assertTransactionDoesNotExist(idempotencyKey): Promise<void>
  async listTransactions(filter?): Promise<HcmTransactionRecord[]>
  async getState(): Promise<MockHcmState>                               // full state object
}
```

**Design rules.**

- **One harness per test suite.** Sharing the HTTP client and connection state. Per-test isolation via `reset()`.
- **All admin endpoint shapes are encapsulated.** Tests never construct raw HTTP requests to admin endpoints.
- **Typed helpers, not strings.** Mode is an enum, not `"normal"`.
- **Documented in code.** Each method has a TSDoc block linking to the TRD section the behavior is specified in.
- **Used by every test layer that touches the mock.** Layers 5 (outbound failure injection), 6 (inbound adversarial — for webhook firing), 7 (reconciliation), 16 (crash recovery), 17 (mock internal), 18 (break-glass), 19 (bootstrap) all use it.

**Tested as a deliverable.** The harness itself has unit tests verifying each method actually has the documented effect on the Mock HCM. Without this, harness bugs masquerade as system bugs.

**Why this matters.** The harness is the single seam between our test code and the mock's behavior. Centralizing it means: when the mock evolves, one file changes. When a test fails, the test reads obviously (no mock plumbing noise). When a new test layer is added, it inherits the same setup discipline. This is purely engineering hygiene, but it's the kind of hygiene that keeps a complex test suite maintainable over time.

## 18. Test Strategy (high-level)

Detailed in `03_Test_Plan.md`. Categories (updated for Revision 3):

1. Unit
2. Integration
3. E2E
4. Property-based (`fast-check`)
5. Outbound failure injection
6. Inbound adversarial
7. Reconciliation
8. Contract
9. Mutation (Stryker)
10. Configuration
11. State machine
12. Error taxonomy
13. Location transfer
14. LeaveTypeAvailability
15. Idempotency (including canonicalization)
16. Crash recovery
17. Mock HCM internal (Revision 2)
18. Break-glass / provisional approval (Revision 2)
19. Employee bootstrap (Revision 2)
20. Point-read jitter / coalescing (Revision 2)
21. **Provisional reconciler exactly-once & event log** (Revision 3, Q.γ)
22. **HR review queue surface** (Revision 3, Q.β)
23. **Provisional action pair-coalescing** (Revision 3, Q.ζ)
24. **MockHcmTestHarness self-tests** (Revision 3, Q.ε)
25. **Cancellation acknowledgment contract** (Revision 3, Q.α)

Coverage targets: ≥ 90% statement, ≥ 85% branch, ≥ 75% mutation kill rate on critical modules.

## 19. Out-of-Scope, Boundary-Defined

Each item: out of scope here; boundary defined for production.

### 19.1 Authentication & Authorization
`AuthGuard` reads gateway headers `x-tenant-id`, `x-actor-id`, `x-actor-role` (where role can be `employee`, `manager`, `break_glass_approver`, `hr_admin`). Tests stub these. Production: gateway terminates SSO and signs headers.

### 19.2 Multi-tenancy
Every domain entity carries a `tenantId` column (omitted in this exercise for clarity). Production: row-level filtering or per-tenant DB.

### 19.3 Observability
Structured logging with `correlationId` via async-local-storage. Counter and histogram hooks. Production: OpenTelemetry exporters; SLOs.

### 19.4 Rate limiting & circuit breaking
HCM adapter wraps calls in a basic circuit breaker; respects `Retry-After`. Production: richer per-tenant breaker.

### 19.5 Real HCM adapters
`HcmAdapterPort` is the interface; mock implements it. Real adapters (Workday, SAP) implement same port. Each adapter passes the contract test suite.

### 19.6 Postgres migration
TypeORM chosen for portability. Production: Postgres for true concurrent writers.

### 19.7 Hourly leave
`units` is `Decimal`; could represent hours. Date model would shift to `DateTime`. Production: data-model change.

### 19.8 Multi-step approval chains
`RequestState` machine could add `PENDING_DIRECTOR_APPROVAL` etc. Single-step today.

### 19.9 GraphQL subscriptions
Not in current schema. Production: live balance updates via WebSocket subscriptions.

### 19.10 HR escalation channel
`ESCALATED_TO_HR` requests need to reach HR. In production: email, ticketing integration, or workflow tool. In this exercise: an audit log entry with severity HIGH; ops can query.

### 19.11 Break-glass governance
Currently, `break_glass_approver` role is binary. Production: configurable per-team thresholds, mandatory dual-approval for high-unit requests, automatic role expiration after period of disuse.

## 20. Alternatives Considered

Detailed in `02_Assumptions_and_Decisions.md`. Summary:

| # | Alternative | Verdict |
|---|---|---|
| A | Pure pass-through | Rejected: no defense surface |
| B | ReadyOn as source of truth | Rejected: violates spec |
| C | Synchronous direct HCM | Rejected: no clean retries |
| D | Distributed transactions / 2PC | Rejected: not supported by HCMs |
| E | Event sourcing | Rejected: heavyweight for our needs |
| F | Cache-only with TTL, no holds | Rejected: degrades UX |
| G | Batch reconciliation only | Rejected: 24h drift |
| H | Real-time only, no batch | Rejected: missed-webhook risk |
| I | BullMQ + Redis | Rejected: dual-write |
| J | Local holds as overdraft preventer | Rejected: HCM is dispositive |
| K | Allow self-approval | Rejected: compliance |
| L | Always fail closed during HCM outage (no break-glass) | Rejected: unacceptable operational cost |
| M | Always allow provisional approval (no break-glass role gate) | Rejected: too permissive; abuse risk |
| N | Bootstrap only via batch | Rejected: 24h latency for new hires |
| O | Bootstrap only via webhook | Rejected: lossy primary path; no safety net |
| P | Native `number` for units | Rejected: float precision |
| Q | Cancel during outage requires break-glass role | Rejected: cancellation is credit; lower risk; UX flag suffices |
| R | Prevent PROVISIONALLY_APPROVED → TAKEN transition | Rejected: the leave happens in the real world regardless |
| S | Distinct TAKEN_UNRECONCILED state | Rejected for now: hrReviewFlag on TAKEN is simpler; splittable later |
| T | Reconcile provisional with reserve/release only (no history pre-flight) | Rejected: cannot guarantee exactly-once across our crashes |
| U | Strict append-only ProvisionalAction (separate reconciliation rows) | Rejected: redundant with ReconciliationStep; over-engineered |
| V | Reconciler issues reserve + release for pair-coalesceable actions | Rejected: wasteful HCM calls and audit noise; coalescing is safer |
| W | Direct mock admin endpoint calls from each test | Rejected: drift, duplication; MockHcmTestHarness centralizes |

## 21. Future Work

This exercise uses SQLite per the spec. The list below covers what would change in a production-grade follow-up and is referenced from `00_Cover_and_Reasoning.md §12`.

### 21.1 Postgres migration

When concurrency or data volume demands it, migrate the service database to Postgres:
- Multi-process workers become viable (`SELECT ... FOR UPDATE SKIP LOCKED` for outbox claim).
- `LISTEN/NOTIFY` for push-based outbox (lower latency than polling).
- Strict append-only triggers more straightforward.
- Concurrent reconciliation passes safe with row-level locks.
- The Mock HCM stays on SQLite — it's per-test-isolated and doesn't need scale.

### 21.2 Other items

- Replace polling with broker once Postgres is in place and throughput justifies it.
- Real adapters (Workday, SAP SuccessFactors). Each implements `HcmPort` including the `queryTransactions` method required by §13.2.1.
- Multi-tenancy with isolation tests.
- Observability stack (OpenTelemetry exporters, dashboards, SLOs).
- GraphQL subscriptions for live UI updates (balance/request state changes).
- Hourly leave (data model change to `DateTime` boundaries).
- Multi-step approval chains (state machine extension).
- Mobile-friendly partial cancellation (early return from leave).
- HR-facing escalation queue UI (consumes `hrReviewQueue`).
- Break-glass governance: configurable thresholds, dual-approval, role expiration, anomaly detection on invocation rates.
- Migrate `ProvisionalAction` to strict append-only via separate `ProvisionalActionReconciliation` table if compliance regulation demands it (see §5.8 alternative b).
