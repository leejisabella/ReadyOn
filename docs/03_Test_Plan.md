# Test Plan

**Status:** Revision 3.1
**Companion to:** `00_Cover_and_Reasoning.md`, `01_TRD.md`, `02_Assumptions_and_Decisions.md`, `04_Module_Plan.md`

---

## CHANGELOG (since Revision 3)

Rev 3.1 closes the open questions from Rev 3 review. Tests added to existing layers where the change is incremental; no new test layers introduced.

- **Layer 21 (UPDATED, Q.κ, Q.ν, Q.λ, Q.θ):** New tests for the history-query window edge, employee-deletion-mid-reconciliation, stale-action alerting, and snapshot summarization.
- **Layer 21 (UPDATED, Q.ι):** New tests for `ReconcilerLease` lock semantics — TTL expiration, foreign-release prevention, concurrent-tick skipping.
- **Layer 22 (UPDATED, Q.μ):** Cursor pagination tests added for `hrReviewQueue` — empty, first page, second page, page boundaries, concurrent inserts, invalid cursor.
- **Layer 12 (UPDATED, Q.ν):** New error code `EMPLOYEE_NOT_FOUND_AT_HCM_DURING_RECONCILIATION` covered.
- **Layer 10 (UPDATED):** Configuration tests for new Rev 3.1 knobs (`reconciler.historyQueryWindowMs`, `reconciler.leaseTtlMs`, `reconciler.snapshotRetention.summarizeAfterSuccess`, `reconciler.staleAlertMetricName`).
- **Layer 24 (UPDATED, Q.ν):** `MockHcmTestHarness` gains a `deleteEmployee` helper for testing the EMPLOYEE_NOT_FOUND_AT_HCM branch.
- **§27 (UPDATED):** Traceability matrix extended to 80 edge cases.

---

## CHANGELOG (since Revision 2)

- **Layer 21 (NEW, Q.γ):** Provisional Reconciler Exactly-Once & Event Log Tests. Pre-flight history query, ReconciliationStep log, crash-mid-reconciliation, advisory locking, exactly-once verification from audit log alone.
- **Layer 22 (NEW, Q.β):** HR Review Queue Tests. All three categories, multiple categories on same request, role gate, filter combinations.
- **Layer 23 (NEW, Q.ζ):** Provisional Action Pair-Coalescing Tests. All four orderings; audit chain preservation; performance (no HCM calls in coalesced path).
- **Layer 24 (NEW, Q.ε):** MockHcmTestHarness Self-Tests. Each helper method verified; lifecycle methods verified; reset/restore/snapshot semantics.
- **Layer 25 (NEW, Q.α):** Cancellation Acknowledgment Contract Tests. With/without flag during outage, audit recording, no-effect when HCM healthy.
- **Layer 8 (UPDATED, Q.γ):** Contract tests cover `queryTransactions` HCM port method.
- **Layer 12 (UPDATED, Q.γ, Q.β, Q.α):** Error taxonomy tests extended with five new error codes.
- **Layer 17 (UPDATED):** Mock HCM internal tests cover `queryTransactions` semantics and the seed/snapshot APIs.
- **Layer 16 (UPDATED, Q.γ):** Crash-recovery tests extended with reconciler crashes between each step (history-query-only, mid-call, mid-outcome).
- **§19 (UPDATED):** Traceability matrix extended to 78 edge cases.
- **§20 (UPDATED):** Five additional rationale paragraphs for the new layers.

---

## CHANGELOG (since Revision 1, preserved)

- **Layer 17:** Mock HCM Internal Tests — verifies the mock itself is correct.
- **Layer 18:** Break-Glass / Provisional Approval Tests — full coverage of provisional flow.
- **Layer 19:** Employee Bootstrap Tests — all three bootstrap paths.
- **Layer 4:** New properties for canonicalization, provisional reconciliation, and bootstrap idempotency.
- **Layer 7:** Reconciliation tests extended with point-read jitter and coalescing.
- **Layer 8:** Contract tests cover the extended HCM port (new operations).
- **Layer 12:** Error taxonomy tests extended to new error codes.
- **Layer 15:** Idempotency tests extended with the four canonicalization ambiguities.
- **Layer 16:** Crash recovery tests cover provisional-action and bootstrap crashes.
- **§19:** Traceability matrix extended to 67 edge cases.
- **§20:** "Why this composition is best" addresses the three new layers.
- **Mock HCM persistence highlighted in §5 and §17.**

---

## Table of Contents

1. [Philosophy & Goals](#1-philosophy--goals)
2. [Test Pyramid](#2-test-pyramid)
3. [Layer 1 — Unit Tests](#3-layer-1--unit-tests)
4. [Layer 2 — Integration Tests](#4-layer-2--integration-tests)
5. [Layer 3 — End-to-End Tests](#5-layer-3--end-to-end-tests)
6. [Layer 4 — Property-Based Tests](#6-layer-4--property-based-tests)
7. [Layer 5 — Outbound Failure-Injection](#7-layer-5--outbound-failure-injection-tests)
8. [Layer 6 — Inbound Adversarial](#8-layer-6--inbound-adversarial-tests)
9. [Layer 7 — Reconciliation](#9-layer-7--reconciliation-tests)
10. [Layer 8 — Contract](#10-layer-8--contract-tests)
11. [Layer 9 — Mutation](#11-layer-9--mutation-tests)
12. [Layer 10 — Configuration](#12-layer-10--configuration-tests)
13. [Layer 11 — State Machine](#13-layer-11--state-machine-tests)
14. [Layer 12 — Error Taxonomy](#14-layer-12--error-taxonomy-tests)
15. [Layer 13 — Location Transfer](#15-layer-13--location-transfer-tests)
16. [Layer 14 — LeaveTypeAvailability](#16-layer-14--leavetypeavailability-tests)
17. [Layer 15 — Idempotency + Canonicalization](#17-layer-15--idempotency-tests)
18. [Layer 16 — Crash Recovery](#18-layer-16--crash-recovery-tests)
19. [Layer 17 — Mock HCM Internal](#19-layer-17--mock-hcm-internal-tests)
20. [Layer 18 — Break-Glass / Provisional Approval](#20-layer-18--break-glass--provisional-approval-tests)
21. [Layer 19 — Employee Bootstrap](#21-layer-19--employee-bootstrap-tests)
22. [Layer 21 — Provisional Reconciler Exactly-Once (NEW, Rev 3)](#22-layer-21--provisional-reconciler-exactly-once-tests)
23. [Layer 22 — HR Review Queue (NEW, Rev 3)](#23-layer-22--hr-review-queue-tests)
24. [Layer 23 — Pair-Coalescing (NEW, Rev 3)](#24-layer-23--pair-coalescing-tests)
25. [Layer 24 — MockHcmTestHarness Self-Tests (NEW, Rev 3)](#25-layer-24--mockhcmtestharness-self-tests)
26. [Layer 25 — Cancellation Acknowledgment Contract (NEW, Rev 3)](#26-layer-25--cancellation-acknowledgment-contract-tests)
27. [Traceability matrix](#27-traceability-matrix)
28. [Why this composition is best](#28-why-this-composition-is-best)
29. [Tooling](#29-tooling)
30. [Coverage Targets](#30-coverage-targets)
31. [CI Integration](#31-ci-integration)

---

## 1. Philosophy & Goals

### Goals

- Every TRD invariant has at least one test.
- Every error code in the taxonomy has a test producing it.
- Every state transition (legal and illegal) is exercised.
- Concurrency invariants are tested with random workloads, not hand-picked interleavings.
- Defensive guarantees are tested with an adversarial mock, not a permissive one.
- Tests run deterministically.
- Coverage targets enforced on critical modules.
- Mutation testing prevents test theatre.
- **The Mock HCM is itself tested** (Revision 2 addition) so the test infrastructure doesn't become a source of false confidence.
- **Break-glass flow has dedicated coverage** including the rare-but-critical "leave taken before HCM confirms" path.

### Anti-goals

- Maximum coverage for its own sake.
- Testing private methods or implementation details.
- Brittle timing assertions.

---

## 2. Test Pyramid

```
         ┌─────────────────┐
         │ Mutation Tests  │   slowest, highest signal
         ├─────────────────┤
         │  E2E + Property │
         ├─────────────────┤
         │  Integration    │
         ├─────────────────┤
         │     Unit        │   fast, plentiful
         └─────────────────┘
```

Each specialized layer (failure injection, inbound adversarial, reconciliation, contract, configuration, state machine, error taxonomy, location, leave-type-availability, idempotency, crash recovery, mock-internal, break-glass, bootstrap) guards a class of regression no other layer covers.

---

## 3. Layer 1 — Unit Tests

**Scope.** Pure functions, single classes, no I/O.

### What's tested

- Date math: `Employment.locationAt(date)`, accrual-boundary detection, day counting.
- Decimal arithmetic via `decimal.js`: add/subtract/compare, rounding, precision matching.
- State-machine transitions: every legal and illegal transition for all four state machines (added `ProvisionalAction.reconciliationState`).
- Idempotency-key resolution.
- Input validators.
- HCM response schema validators.
- Backoff math.
- Audit-event construction.
- **Canonical input serializer** — see Layer 15 for the four-ambiguity test suite.
- Error-code mapping.
- HCM health hysteresis logic (`HcmHealthMonitor`).
- Break-glass authorization checks (role + outage threshold).
- Point-read scheduler logic (jitter generation, coalescing map).

Roughly 250-350 unit tests. Run in < 5 seconds.

---

## 4. Layer 2 — Integration Tests

**Scope.** NestJS modules wired together with real SQLite, HCM port stubbed.

### What's tested

- Repository correctness, including new `Employee` and `ProvisionalAction` tables.
- GraphQL resolvers: every Query and Mutation, including `approveTimeOffRequestProvisionally`, `hcmHealth`, `provisionalActions`.
- Service-layer flows: create → approve happy path; reject; cancel pre/post-approval; provisional approval; provisional cancellation; reconciliation on recovery.
- Outbox/Inbox in isolation.
- AuditEvent integration: assert every domain action emits the expected audit row, including new actions (`BREAK_GLASS_APPROVAL_INVOKED`, `PROVISIONAL_APPROVAL_CONFIRMED`, etc.).
- Module wiring.

About 120-180 tests. Run in 30-90 seconds.

---

## 5. Layer 3 — End-to-End Tests

**Scope.** Full stack with separate Mock HCM process, real HTTP.

### What's tested

- Happy path: create → approve → reconciled.
- Concurrent approvals: HCM serializes; one APPROVED, one REJECTED.
- HCM unavailable at approval, outage < threshold: HCM_UNAVAILABLE; no break-glass offered.
- HCM unavailable at approval, outage ≥ threshold, role present: break-glass available; PROVISIONALLY_APPROVED on invocation.
- HCM recovers, provisional reconciliation: APPROVED.
- HCM recovers, provisional reconciliation rejects: ESCALATED_TO_HR.
- Provisional approval, leave taken during outage, HCM rejects on recovery: ESCALATED_TO_HR with severity flag; audit trail preserved.
- HCM unavailable at create: succeeds with warning.
- HCM transient 5xx: outbox retries.
- HCM timeout then idempotent retry.
- Webhook flow: BALANCE_UPDATED, EMPLOYMENT_CHANGED, LEAVE_TYPE_CHANGED, EMPLOYEE_CREATED.
- Anniversary mid-flight: handled correctly.
- Cancellation post-approval (HCM available): standard saga.
- Cancellation post-approval (HCM unavailable): provisional; reconciled on recovery.
- Batch reconciliation drift: induced via mock admin; reconciler converges.
- **Crash and recover (highlighted, NEW emphasis):** kill service mid-outbox-call; restart; verify recovery. Uses Mock HCM's durable SQLite to verify HCM's post-state.
- Crash mid-break-glass: ProvisionalAction either fully written or absent (atomic).
- Bootstrap on first touch: new employee submits request; lazy pull populates; succeeds.

About 60-100 tests. Run in 3-7 minutes.

---

## 6. Layer 4 — Property-Based Tests

**Scope.** `fast-check` generates random workloads; tests assert invariants.

### Properties asserted

1. **HCM is dispositive when reachable (no overdraft).** Random create/approve sequences; whenever HCM is set to reject, no APPROVED request exists for which HCM never confirmed a debit.
2. **Provisional reconciliation soundness.** For any sequence of break-glass approvals during outage, when HCM recovers, every PROVISIONALLY_APPROVED request ends in {APPROVED, ESCALATED_TO_HR} — never stuck in PROVISIONALLY_APPROVED forever.
3. **Idempotent replay.** Replaying any committed mutation N times produces the same final state.
4. **Sum-of-approved invariant.** `sum(APPROVED.units) == sum(HCM debits for employee)` at any reconciliation checkpoint, after reconciliation completes.
5. **Order-independence of inbox.** Any sequence of webhooks with monotonic `hcmVersion` produces same final state regardless of arrival order.
6. **Inbox dedup.** Duplicate delivery is a no-op beyond first.
7. **State-machine progress.** From any state, only declared transitions reachable.
8. **Location attribution stability.** For a request submitted at time T with start date S, the `locationId` equals `Employment.locationAt(S)` evaluated against the timeline as of T.
9. **Idempotency-key snapshot stability.** Same key + same canonical hash → byte-identical response across N replays.
10. **`hcmVersion` monotonicity preserved.**
11. **Auditing completeness.** Every state transition has a matching `AuditEvent`.
12. **Canonicalization commutativity (NEW).** For any two inputs that differ only in canonicalization-equivalent ways (field order, decimal format, date format, NFC/NFD), the `inputHash` is identical.
13. **Bootstrap idempotency (NEW).** Any sequence of `bootstrapFromWebhook`, `bootstrapLazy`, `bootstrapFromBatch` for the same employee produces a single `Employee` row with consistent state.
14. **Point-read coalescing soundness (NEW).** No matter how many point-reads are scheduled for a single balance, at most one read fires per scheduling-window; the read result is applied to the balance correctly.
15. **`appliedAt` independence (NEW).** Random clock skews on `appliedAt` do not affect ordering decisions; only `hcmVersion` controls.
16. **Provisional action chain integrity (NEW).** For any sequence of break-glass + provisional-cancel on the same request, the audit chain is reconstructable and the final state is consistent.

About 16-25 properties. Run in 3-7 minutes.

---

## 7. Layer 5 — Outbound Failure-Injection Tests

**Scope.** Mock HCM in each adversarial mode.

For each mode (`flaky`, `silent_no_op`, `wrong_delta`, `missing_confirmation`, `stale_version`, `malformed`, `slow`, `version_skew`, `unreachable`), test that the system converges to a correct steady state.

### Notable additions for Revision 2

- **`unreachable` mode + sustained duration:** triggers HCM_UNAVAILABLE; after `breakGlassMinOutageMs`, the system reports break-glass as available via `hcmHealth` query.
- **`unreachable` mode + role-gated break-glass invocation:** PROVISIONALLY_APPROVED succeeds; on HCM recovery, full reconciliation path tested.
- **Anniversary bump arriving during provisional reconciliation:** reconciler still proceeds; `deltaApplied` validation catches any interference.

About 40-60 tests. Run in 2-4 minutes.

---

## 8. Layer 6 — Inbound Adversarial Tests

Webhook handling under attack: signature validation (HMAC, timing-safe compare), replay, dedup, out-of-order, malformed payloads, flood, unknown employee (triggers bootstrap if EMPLOYEE_CREATED, else logged), bad signatures, cross-tenant (boundary).

Also: webhook arriving with `appliedAt` in the future (clock skew) does not affect ordering — only `hcmVersion` does.

About 30-45 tests. Run in 30-90 seconds.

---

## 9. Layer 7 — Reconciliation Tests

**Scope.** All cadences and the new provisional reconciler.

### What's tested

- Per-commit point-read: scheduled at `commit_time + delay + jitter`; coalesced per-balance; drained at configured rate.
- Periodic drift sweep.
- Full batch reconciliation.
- Reconciler running while outbox in flight.
- New leave types in batch; removed leave types.
- New employees in batch (bootstrap via batch path).
- Convergence under sustained drift.
- **Provisional reconciliation pass (NEW):**
  - HCM recovers; reconciler processes all PENDING ProvisionalActions.
  - Each action: invoke HCM; based on response → CONFIRMED, REJECTED_ESCALATED, or NO_OP.
  - Order: oldest invokedAt first.
  - Idempotent: re-running reconciliation against already-CONFIRMED actions is a no-op.
  - HCM transient failure during reconciliation: action stays PENDING.
  - Multiple concurrent ProvisionalActions for same employee/balance: reconciler handles in order; later ones may see different HCM state.
- **Point-read jitter and coalescing (NEW):**
  - Burst of 100 commits in 1 second: point-reads spread over the jitter window.
  - 100 commits all on the same balance: only one point-read fires.
  - Drainer respects rate limit: with rate=10/s, 100 reads take ≥ 10 seconds.

About 35-55 tests. Run in 2-4 minutes.

---

## 10. Layer 8 — Contract Tests

HCM port is pinned. Schemas validated on every request and response. Required transaction confirmation fields present on every mutation response. Adapter conformance suite parameterized.

Revision 2: contract extended with `fetchEmployee`, `createEmployee` notification, and the `reconcileProvisional` use of stable idempotency keys.

About 20-30 tests. Run in seconds.

---

## 11. Layer 9 — Mutation Tests

Stryker on critical modules: `BalanceService`, `RequestService`, `HcmResponseValidator`, `EmploymentService`, `IdempotencyService`, `OutboxWorker`, `Reconciler`, and (NEW in Revision 2) `HcmHealthMonitor`, `BreakGlassAuthorizer`, `ProvisionalReconciler`, `CanonicalInputSerializer`, `EmployeeBootstrapService`.

Target: **≥ 75% overall kill rate**, enforced by Stryker's `thresholds.break: 75` in [stryker.config.json](../stryker.config.json). Current overall score: **75.38%**. Per-file scores vary; two modules sit below 75% individually (`request.service.ts` at 60.69%, `provisional-reconciler.service.ts` at 57.78%) — the overall gate still passes.

`StringLiteral` mutations are excluded via `mutator.excludedMutations`: TRD specifies error codes, payload shape, and observable behaviour but never exact wording of audit / log / error message text. Gating on cosmetic text changes would test implementation detail rather than design.

Runs on push to main + nightly cron via [`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml); ~23 min wall-clock with `coverageAnalysis: "perTest"`.

---

## 12. Layer 10 — Configuration Tests

Every config knob's effect is asserted. New knobs covered in Revision 2:

- `hcm.healthCheckIntervalMs`
- `hcm.healthRecoveryWindowMs`
- `reconciliation.pointReadJitterMs`
- `reconciliation.pointReadMaxRatePerSecond`
- `breakGlass.minOutageMs`
- `breakGlass.requireRole`
- `cancellation.pendingAlertThresholdMs`
- `policy.leaveTypePrecision`
- `policy.advanceLeaveToleranceUnits` (tested as UX hint, not enforcement)

About 25-40 tests.

---

## 13. Layer 11 — State Machine Tests

Full transition matrix per machine. Revision 2 extends RequestState with new states.

### New transitions tested

| From → To | Legal? | Trigger | Test |
|---|---|---|---|
| PENDING_APPROVAL → PROVISIONALLY_APPROVED | yes | break-glass invoke | T-RS-16 |
| PROVISIONALLY_APPROVED → APPROVED | yes | HCM recovery + accept | T-RS-17 |
| PROVISIONALLY_APPROVED → ESCALATED_TO_HR | yes | HCM recovery + reject | T-RS-18 |
| PROVISIONALLY_APPROVED → CANCELLED | yes | provisional cancellation during outage | T-RS-19 |
| PROVISIONALLY_APPROVED → TAKEN | yes | end date passes before HCM recovery | T-RS-20 |
| PROVISIONALLY_APPROVED → anything else | no | — | T-RS-IL-06 |
| ESCALATED_TO_HR → anything | no | — | T-RS-IL-07 |
| Any → PROVISIONALLY_APPROVED outside PENDING_APPROVAL | no | — | T-RS-IL-08 |

Plus ProvisionalAction.reconciliationState transitions: PENDING → {CONFIRMED, REJECTED_ESCALATED, NO_OP}.

About 60-80 tests total.

---

## 14. Layer 12 — Error Taxonomy Tests

Every error code has at least one test producing it. New codes in Revision 2:

- `BREAK_GLASS_NOT_AUTHORIZED` — caller lacks `break_glass_approver`.
- `BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET` — outage too short.
- `PROVISIONAL_RECONCILIATION_REJECTED` — internal; routed to ESCALATED_TO_HR.
- `EMPLOYEE_NOT_BOOTSTRAPPED` — employee unknown and lazy pull failed.

Plus assertions on the `retryable` flag value per code, and audit-event emission.

About 25-35 tests.

---

## 15. Layer 13 — Location Transfer Tests

Unchanged from Revision 1; about 25-35 tests covering the full transfer surface (TRD §15 cases 19-25). Plus new: provisional approval + transfer interaction. If a transfer arrives while a request is PROVISIONALLY_APPROVED, the request is revalidated against the new location (TRD §12.4).

---

## 16. Layer 14 — LeaveTypeAvailability Tests

Unchanged. About 15-20 tests.

---

## 17. Layer 15 — Idempotency Tests (extended with canonicalization)

### Inbound

- Same key + same input → cached response.
- Same key + different input → IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT.
- New key → new response.
- TTL expiration → reusable.
- Concurrent same-key requests → exactly one wins, both get same response.

### Outbound

- Outbox retry uses same idempotency key.
- HCM returns prior result on retry.
- Stable across worker restarts.
- For provisional reconciliation: idempotency key is `ProvisionalAction.id`, stable across all retries.

### Canonicalization (NEW — comprehensive)

Tests for every rule in TRD §14.4:

- **Field ordering:** `{"a":1,"b":2}` vs `{"b":2,"a":1}` → same hash.
- **Date formats:** `"2025-01-15"` vs `"2025-01-15T00:00:00Z"` vs `"2025-01-15T00:00:00.000Z"` → same hash for date-only fields. Different hash if one has time component for a datetime field.
- **Decimal formats:** `2`, `2.0`, `"2"`, `"2.00"`, `"2.000"` → same hash (after parsing through Decimal at configured precision).
- **Unicode normalization:** NFC `é` (single codepoint) vs NFD `é` (e + combining accent) → same hash.
- **Whitespace:** trailing whitespace in JSON pretty-printed vs minified → same hash.
- **Boolean canonicalization:** `true` vs `"true"` → different hash (booleans vs strings are semantically different).
- **Extra unknown fields:** stripped before hashing; adding an unrelated field doesn't change hash.
- **Combinations:** all four ambiguities at once → same hash.

About 25-35 tests.

---

## 18. Layer 16 — Crash Recovery Tests

**Scope.** Process restarts at every saga step. Mock HCM's durable SQLite is the verification authority.

### What's tested

- Crash after DB commit, before outbox dispatch → outbox persists, worker resumes.
- Crash during HCM call → idempotency key replays, HCM returns prior result.
- Crash after HCM success, before applying response → idempotent.
- Crash mid-reconciliation → idempotent restart.
- Crash during inbox processing → exactly-once.
- Crash during state-machine transition → atomic rollback.
- **Crash during break-glass invocation (NEW)** → ProvisionalAction either fully written or absent.
- **Crash during provisional reconciliation (NEW)** → action remains PENDING; next reconciler tick resumes; HCM idempotency key (ProvisionalAction.id) prevents double-debit.
- **Crash during lazy bootstrap (NEW)** → Employee row either fully written or absent; race with webhook bootstrap is safe.
- **Mock HCM verification:** after each crash test, query Mock HCM's `/admin/state` to verify the actual HCM-side outcome (e.g., "HCM has the debit" or "HCM doesn't"). This is why the Mock HCM has a durable SQLite store.

About 18-25 tests. Run in 2-3 minutes.

---

## 19. Layer 17 — Mock HCM Internal Tests (NEW)

**Scope.** The Mock HCM is itself non-trivial software. This layer verifies the mock behaves correctly for each declared mode.

### Why this layer exists

The Mock HCM is the test infrastructure for several layers above (failure injection, E2E, crash recovery). A bug in the mock produces false confidence — every test using the mock might pass even though the production behavior would fail. We added this layer specifically to catch mock bugs and ensure project viability — every test that depends on the mock can trust the mock's claims.

This pattern (test-the-test) is justified when:
- The test infrastructure is complex enough to have its own bugs.
- The cost of a mock bug is multiplicative across all tests using the mock.
- Both conditions hold here.

### What's tested

- **Each adversarial mode does what it claims.**
  - `normal`: honest debits/credits.
  - `flaky`: returns 5xx at configured rate, eventually succeeds.
  - `silent_no_op`: returns 200 with `deltaApplied = 0`.
  - `wrong_delta`: returns 200 with `deltaApplied ≠ requested`.
  - `missing_confirmation`: returns 200 with fields omitted.
  - `stale_version`: returns `hcmVersion ≤ current`.
  - `malformed`: returns invalid JSON.
  - `slow`: returns after configured delay.
  - `version_skew`: returns versions out of order.
  - `unreachable`: connection errors / timeouts.
- **Webhook firing.** Internal balance changes fire BALANCE_UPDATED webhooks. EMPLOYMENT_CHANGED, LEAVE_TYPE_CHANGED, EMPLOYEE_CREATED similarly.
- **Webhook delivery configuration.** Delay, drop rate, duplicate rate, out-of-order rate, signature validity all honored.
- **Admin endpoints work correctly.** `setBalance`, `setEmployment`, `setLeaveTypeAvailability`, `createEmployee`, `scheduleEvent`, `setMode`, `setReachability`, `triggerWebhookFlood`, `state`.
- **Persistence.** SQLite store survives restart; admin reset clears state cleanly.
- **Idempotency.** Idempotency-Key header on reserve/release results in deduplication.
- **Health endpoint.** Reports reachability honestly.

About 20-30 tests. Run in 1-2 minutes.

---

## 20. Layer 18 — Break-Glass / Provisional Approval Tests (NEW)

**Scope.** End-to-end behavior of the break-glass mechanism and its reconciliation.

### What's tested

#### Eligibility

- Break-glass attempted when HCM is reachable → BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET (because no outage).
- Break-glass attempted, outage < `breakGlassMinOutageMs` → BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET.
- Break-glass attempted, threshold met, role missing → BREAK_GLASS_NOT_AUTHORIZED.
- Break-glass attempted, threshold met, role present → PROVISIONALLY_APPROVED.

#### Invocation

- Break-glass on a non-PENDING_APPROVAL request → STATE_TRANSITION_NOT_ALLOWED.
- Break-glass missing justification → validation error.
- Self-approval via break-glass (actorId == employeeId) → rejected.
- Break-glass with idempotency key → idempotent replay returns same ProvisionalAction.

#### Provisional state

- `provisionalHold` increases by request units; `pendingHold` decreases.
- `BalanceState` may transition to UNDER_HOLD_DEFICIT if total holds exceed available.
- ProvisionalAction row inserted with full localStateSnapshot.
- AuditEvent with severity HIGH inserted.

#### Reconciliation on recovery

- HCM recovers, reconciler triggered.
- ProvisionalAction with type BREAK_GLASS_APPROVAL: HCM call made with action.id as idempotency key.
- HCM accepts → request → APPROVED, balance updated, action → CONFIRMED.
- HCM rejects → request → ESCALATED_TO_HR, action → REJECTED_ESCALATED, severity-HIGH AuditEvent.
- HCM transient failure → action stays PENDING; retried on next reconciler tick.
- Order: oldest action reconciled first (fairness).

#### Edge cases

- Provisional approval, then employee cancels before reconciliation → CANCELLED via provisional cancellation; both actions marked NO_OP.
- Provisional approval, leave date passes before HCM recovers → PROVISIONALLY_APPROVED + TAKEN flag; reconciler still attempts HCM; on rejection → ESCALATED_TO_HR with severity flag for "leave already taken".
- Provisional approval, transfer arrives during outage → request → NEEDS_REVALIDATION; new location compatible → revalidates; new location incompatible → ESCALATED_TO_HR.
- Concurrent break-glass attempts on same request → only one succeeds; other gets STATE_TRANSITION_NOT_ALLOWED.

#### HCM Health Monitor

- Initial state: reachable (after first successful health check).
- HCM down: state UNAVAILABLE after consecutive failed checks.
- HCM back: state remains UNAVAILABLE until `healthRecoveryWindowMs` of consecutive successes (hysteresis).
- Flapping HCM: state oscillation prevented by hysteresis.
- `hcmHealth` GraphQL query returns correct state.

#### Provisional Cancellation Path

- Cancel APPROVED request during HCM outage → CANCELLATION_PENDING (no break-glass needed).
- Cancel PROVISIONALLY_APPROVED request during same outage → CANCELLED locally; original break-glass action → NO_OP; cancellation action → NO_OP (no HCM action needed).
- Cancellation pending threshold exceeded → CANCELLATION_TAKING_LONGER_THAN_EXPECTED audit event fires.

About 40-55 tests. Run in 2-4 minutes.

---

## 21. Layer 19 — Employee Bootstrap Tests (NEW)

**Scope.** All three bootstrap paths and their interactions.

### Webhook path

- EMPLOYEE_CREATED event received → Employee inserted, employment created.
- Duplicate webhook (same eventId) → deduplicated, no double-insert.
- Out-of-order: EMPLOYEE_CREATED arrives after EMPLOYMENT_CHANGED for same employee → handled correctly via version check.
- Webhook for employee already known (from lazy pull) → no-op or version-aware update.

### Lazy pull path

- API call references unknown employee → triggers lazy pull.
- HCM responds with employee data → Employee inserted; original API call proceeds.
- HCM responds 404 → EMPLOYEE_NOT_BOOTSTRAPPED.
- HCM unavailable during lazy pull → HCM_UNAVAILABLE.
- Lazy pull populates Employment, Balances, LeaveTypeAvailability.

### Batch path

- New employee in daily batch → Employee inserted with source=BATCH.
- Employee already known but in batch → no-op or version-aware update.

### Race conditions

- Webhook + lazy pull race: concurrent attempts to bootstrap same employee → exactly one insert succeeds, other becomes no-op (idempotent via PK constraint).
- Batch + webhook race: same.
- Lazy pull + batch race: same.

### Audit

- Every bootstrap emits an EMPLOYEE_BOOTSTRAPPED audit event with `source` field.

About 18-25 tests. Run in 1-2 minutes.

---

## 22. Layer 21 — Provisional Reconciler Exactly-Once Tests (NEW, Rev 3, Q.γ)

**Scope.** The provisional reconciler's exactly-once execution properties: pre-flight history query, ReconciliationStep event log, crash recovery resumption, advisory locking.

### Test IDs and scenarios

- **T-PR-EX-01** — Happy path: pending action → history shows no transaction → call HCM → outcome applied → step log shows three TERMINAL steps; ProvisionalAction = CONFIRMED.
- **T-PR-EX-02** — Pre-existing transaction (matching key + delta): history returns one record; reconciler skips reserve call; outcome applied based on existing transaction; ProvisionalAction = CONFIRMED; only TWO HCM calls (history + no actual reserve); ReconciliationStep log shows `HCM_HISTORY_QUERIED` then `OUTCOME_APPLIED` with no `HCM_CALL_IN_FLIGHT`.
- **T-PR-EX-03** — Pre-existing transaction with MISMATCHED delta: history returns one record but delta is wrong; ProvisionalAction → REJECTED_ESCALATED with reason "HCM transaction exists with different delta"; request → ESCALATED_TO_HR.
- **T-PR-EX-04** — History query transient failure: HCM returns 503 on history query; reconciler logs `HCM_HISTORY_QUERY_FAILED`; leaves action PENDING; retries next tick.
- **T-PR-EX-05** — Crash after history query, before call: kill the service after `HCM_HISTORY_QUERIED` step. Restart. Verify next reconciler tick re-runs history query (cheap, idempotent) then proceeds. Step log has both queries; second is the authoritative one.
- **T-PR-EX-06** — Crash mid-call: kill service after `HCM_CALL_IN_FLIGHT` step but before `OUTCOME_APPLIED`. Mock HCM did apply the change (it's durable). Restart. Verify history query reveals the transaction; reconciler applies outcome correctly. Exactly one HCM debit recorded.
- **T-PR-EX-07** — Crash mid-call, HCM did NOT apply: mock HCM in `unreachable` mode crashes our caller. Restart. History query returns nothing. Reconciler calls reserveBalance with action.id key. Exactly one HCM debit results.
- **T-PR-EX-08** — Concurrent reconciler instances: two reconciler ticks invoked at the same moment. Advisory lock ensures only one proceeds. Other returns `skipped: true`. ReconciliationStep log shows steps from only one worker.
- **T-PR-EX-09** — ReconciliationStep insert failure (synthetic): force insert to throw; verify reconciler aborts without making HCM call. Action remains PENDING.
- **T-PR-EX-10** — Audit chain verification: from a CONFIRMED ProvisionalAction, walk audit log backward through `AuditEvent(PROVISIONAL_APPROVAL_CONFIRMED) → ReconciliationStep(OUTCOME_APPLIED) → ReconciliationStep(HCM_CALL_IN_FLIGHT) → ReconciliationStep(HCM_HISTORY_QUERIED) → AuditEvent(BREAK_GLASS_APPROVAL_INVOKED) → ProvisionalAction.localStateSnapshot`. Verify each step has the expected ID linkage and payload.
- **T-PR-EX-11** — Idempotency at boundary: invoke reconciler twice on same action.id manually (no concurrent race; explicit double-call). Second invocation detects `lastStep.outcome == TERMINAL` and skips; no second HCM call.

### Rev 3.1 tests

- **T-PR-EX-12** (Q.ν) — Employee deleted at HCM: seed an employee, invoke break-glass, simulate HCM accepting the action, then delete the employee at HCM via `MockHcmTestHarness.deleteEmployee()`, then run reconciler. Verify: history query returns `EMPLOYEE_NOT_FOUND`; `EMPLOYEE_NOT_FOUND_AT_HCM` step inserted; ProvisionalAction → REJECTED_ESCALATED; request → ESCALATED_TO_HR with `hrReviewReason = "Employee no longer exists in HCM"`; surfaces in `hrReviewQueue`.
- **T-PR-EX-13** (Q.ν) — Employee deleted between history query and call: history returns nothing (employee still existed during window query); proceed to call HCM; call returns `EMPLOYEE_NOT_FOUND`. Verify same terminal outcome as T-PR-EX-12.
- **T-PR-EX-14** (Q.κ) — History window respected: seed a transaction with `appliedAt` outside `historyQueryWindowMs`; run reconciler. Verify the out-of-window transaction is NOT returned; reconciler proceeds with a fresh call; HCM's own idempotency-key handling dedupes correctly.
- **T-PR-EX-15** (Q.κ) — History window default 24h: verify default config; verify configurable override; verify window math handles `action.invokedAt` near current time.
- **T-PR-EX-16** (Q.λ) — Stale audit event fires: insert a `ProvisionalAction` with `invokedAt` older than `provisionalActionStaleAlertMs`; run reconciler with HCM still unavailable. Verify `PROVISIONAL_ACTION_STALE` audit event emitted with HIGH severity and correct payload (age, last step, HCM health).
- **T-PR-EX-17** (Q.λ) — Stale alert deduplication: same stale action across two consecutive ticks → only ONE audit event in window (idempotent via `lastStaleAlertAt`); metric gauge updated on both ticks regardless.
- **T-PR-EX-18** (Q.λ) — Stale metric gauge: with 3 stale actions across age buckets, verify the gauge has value 3, tagged by `outage_age_bucket` accurately; drain one action → gauge drops to 2; drain all → gauge reaches 0.
- **T-PR-EX-19** (Q.θ) — Snapshot summarization on CONFIRMED: invoke break-glass, reconcile to CONFIRMED. Verify `localStateSnapshot` is null; `localStateSnapshotSummary` is populated with structural data (balance hash, request IDs, decision metadata) and is small (< 500 bytes).
- **T-PR-EX-20** (Q.θ) — Snapshot retention on ESCALATED: invoke break-glass; force HCM to reject on reconciliation. Verify `localStateSnapshot` is retained in full; `localStateSnapshotSummary` is also populated.
- **T-PR-EX-21** (Q.θ) — Summarization disabled: set `reconciler.snapshotRetention.summarizeAfterSuccess = false`; reconcile to CONFIRMED. Verify `localStateSnapshot` is retained in full.
- **T-PR-EX-22** (Q.ι) — Lease TTL expiration: worker acquires lease but does NOT release it (simulated crash); wait > leaseTtlMs; next worker acquires lease successfully.
- **T-PR-EX-23** (Q.ι) — Foreign release prevention: worker A acquires lease, lease expires, worker B acquires. Worker A (resuming somehow) attempts to release. Verify release is rejected (heldBy predicate); worker B's lease unaffected.
- **T-PR-EX-24** (Q.ι) — Lease debuggability: at any moment, querying `reconciler_lease` shows current holder and expiry. Verified by direct SQL during a tick.

### Property-based tests (subset)

- **T-PR-PROP-01** — For all random sequences of {pending action insert, reconciler tick, simulated crashes between steps}: at the end, the number of HCM transactions for the action.id equals 0 or 1 (never 2+).
- **T-PR-PROP-02** — For all sequences: ProvisionalAction.reconciliationState is eventually TERMINAL (CONFIRMED, REJECTED_ESCALATED, or NO_OP) given HCM eventually healthy.
- **T-PR-PROP-03** — Step log replay: reading only ReconciliationStep rows for an action.id is sufficient to reconstruct the reconciler's history (no hidden state in memory).
- **T-PR-PROP-04** (Rev 3.1) — For all sequences including employee deletion: actions reach a terminal state; no reconciler crash; ESCALATED_TO_HR is reached when appropriate.

About 38-50 tests. Run in 3-4 minutes.

---

## 23. Layer 22 — HR Review Queue Tests (NEW, Rev 3, Q.β)

**Scope.** The `hrReviewQueue` GraphQL query and the conditions under which requests surface in it.

### Test IDs

- **T-HR-01** — Empty queue: no requests in any escalation state. Query returns empty list.
- **T-HR-02** — Category 1 (ESCALATED_PRE_LEAVE): pre-leave reconciliation rejection. Query includes the request with category `ESCALATED_PRE_LEAVE`.
- **T-HR-03** — Category 2 (ESCALATED_POST_LEAVE): provisional approval, leave taken, then HCM rejects. Verify request transitions to `TAKEN` with `hrReviewFlag = true`. Query includes it with category `ESCALATED_POST_LEAVE`.
- **T-HR-04** — Category 3 (CANCELLATION_STUCK): cancellation pending longer than threshold. Query includes it.
- **T-HR-05** — Multi-category request: a request with both an escalation and a stuck cancellation. Query includes it once with the most-severe category.
- **T-HR-06** — Filter by `categories`: query restricted to one category.
- **T-HR-07** — Filter by `employeeId`: only that employee's escalations.
- **T-HR-08** — Filter by `locationId`: only requests for that location.
- **T-HR-09** — Role gate: caller without `hr_admin` role → request blocked at the API boundary (UNAUTHORIZED).
- **T-HR-10** — Provisional actions attached: each item includes its full `ProvisionalAction` list for audit context.
- **T-HR-11** — Audit chain accessible: each HR review item links to all `ReconciliationStep` rows through `provisionalActions`.

### Rev 3.1 pagination tests (Q.μ)

- **T-HR-PAG-01** — Empty queue with pagination: connection has empty `edges`, `pageInfo.hasNextPage = false`, `pageInfo.startCursor = null`, `totalCount = 0`.
- **T-HR-PAG-02** — Full page: queue size 100, `first: 50` returns 50 edges, `pageInfo.hasNextPage = true`, valid `endCursor`, `totalCount = 100`.
- **T-HR-PAG-03** — Second page: pass the prior `endCursor` as `after`. Returns the next 50 items; `hasNextPage = false`; same `totalCount = 100`.
- **T-HR-PAG-04** — Cursor stability: items appearing during pagination (new escalation arrives between page 1 and page 2 requests) do not appear duplicated in page 2; they appear on a fresh page-1 request.
- **T-HR-PAG-05** — Max page size clamping: `first: 1000` is clamped to 200; returns 200 edges with a `Warning` extension noting the clamp.
- **T-HR-PAG-06** — Invalid cursor: malformed `after` value → `INVALID_CURSOR` error with helpful message.
- **T-HR-PAG-07** — Order is `flaggedAt DESC`: most recently flagged items first; stable secondary order by `request.id`.
- **T-HR-PAG-08** — Pagination respects filters: `categories: [ESCALATED_PRE_LEAVE], first: 10` returns only that category, paginated.

About 20-28 tests. Run in 45-90 seconds.

---

## 24. Layer 23 — Pair-Coalescing Tests (NEW, Rev 3, Q.ζ)

**Scope.** Reconciler's pair-coalescing logic for opposing provisional actions on the same request.

### Test IDs

- **T-PC-01** — Approval then cancellation (same outage): both actions → NO_OP. Request final state CANCELLED. Zero HCM mutation calls (queryTransactions may run as part of guard). `PROVISIONAL_PAIR_COALESCED` audit event recorded.
- **T-PC-02** — Cancellation only (no prior approval): not a pair; reconciled individually with releaseBalance.
- **T-PC-03** — Approval only (no cancellation): not a pair; reconciled individually with reserveBalance.
- **T-PC-04** — Double approval on same request: state machine rejects the second at API; never two pending approvals.
- **T-PC-05** — Double cancellation on same request: second is recognized as idempotent NO_OP at the cancel mutation layer; never two pending cancellations of the same request.
- **T-PC-06** — Pair on request A, single action on request B: reconciler coalesces A's pair, individually reconciles B. Step log shows correct lineage for each.
- **T-PC-07** — Audit chain preservation: after coalescing, both `ProvisionalAction` rows persist with `reconciliationState = NO_OP`. `PROVISIONAL_PAIR_COALESCED` audit event links them.
- **T-PC-08** — No HCM calls during coalescing: instrument the HCM port; assert zero `reserveBalance` and zero `releaseBalance` calls during the coalesced reconciliation.
- **T-PC-09** — Coalescing interleaved with non-coalesceable actions in the same pass: ordering preserved; coalescing pass runs first.

About 10-15 tests. Run in 30 seconds.

---

## 25. Layer 24 — MockHcmTestHarness Self-Tests (NEW, Rev 3, Q.ε)

**Scope.** The harness itself is non-trivial code; bugs in it would manifest as misleading test failures throughout the suite.

### Test IDs

- **T-HRN-01** — `reset()` clears all mock state: seed several balances; call reset; assertions show empty state.
- **T-HRN-02** — `seedBalance()` creates a balance: seed; call mock API directly to verify (bypassing harness, this once).
- **T-HRN-03** — `setMode('flaky')` results in 5xx on subsequent mock calls: harness sets mode; test makes a request via the service; observes the flaky behavior.
- **T-HRN-04** — `setReachability('off')` blocks all calls: harness sets unreachable; request attempts time out as expected.
- **T-HRN-05** — `snapshot()` and `restoreSnapshot()`: seed state, take snapshot, modify state, restore. State equals snapshot.
- **T-HRN-06** — `assertTransactionExists()`: with matching transaction, passes; without, throws.
- **T-HRN-07** — `assertTransactionDoesNotExist()`: symmetric.
- **T-HRN-08** — `triggerWebhookFlood()`: configured count of webhooks delivered to the service's inbox endpoint within bounded time.
- **T-HRN-09** — `scheduleBalanceUpdate()` with delay: webhook fires after delay; before delay, no webhook.
- **T-HRN-10** — Lifecycle: `beforeAll` (construct), `beforeEach` (reset), `afterAll` (shutdown). Verify connections cleaned up.
- **T-HRN-11** — Documentation: every method has TSDoc and a TRD reference (verified via lint rule or test).

About 12-18 tests. Run in 30 seconds. **Recommended to run early in CI** — a broken harness invalidates higher-layer tests.

---

## 26. Layer 25 — Cancellation Acknowledgment Contract Tests (NEW, Rev 3, Q.α)

**Scope.** The `acknowledgedHcmUnavailable` flag contract for cancellation during HCM outage.

### Test IDs

- **T-CACK-01** — Cancel APPROVED during HCM outage WITHOUT flag → `CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT` error.
- **T-CACK-02** — Cancel APPROVED during HCM outage WITH flag → ProvisionalAction recorded; state CANCELLATION_PENDING; audit event includes `acknowledgmentFlag: true`.
- **T-CACK-03** — Cancel APPROVED with HCM healthy, with or without flag → flag has no effect; standard cancellation flow.
- **T-CACK-04** — Cancel PENDING_APPROVAL during outage → no flag needed; local-only cancel.
- **T-CACK-05** — Cancel during outage, flag set, then retried: idempotency replays; no second ProvisionalAction.
- **T-CACK-06** — Audit traceability: from the ProvisionalAction, walk to the AuditEvent; verify `acknowledgmentFlag` field present and accurate.
- **T-CACK-07** — Different actorIds: each cancellation records the correct actor in the ProvisionalAction.

About 7-10 tests. Run in 20 seconds.

---

## 27. Traceability Matrix

Every edge case in TRD §15 maps to one or more tests.

| TRD §15 Case | Layer | Test ID(s) |
|---|---|---|
| 1. Concurrent approvals | Property-based, E2E | T-PROP-01, T-E2E-CONC-01 |
| 2. Concurrent create+approve | Property-based | T-PROP-02 |
| 3. Concurrent cancel+approval | State machine | T-RS-09a |
| 4-10. HCM defensive | Failure injection | T-FI-* |
| 11. Anniversary bump | E2E | T-E2E-ANNIV-01 |
| 12. Year-start herd | Reconciliation | T-RECON-BATCH-HERD-01 |
| 13. Retro correction | Reconciliation | T-RECON-RETRO-01 |
| 14-18. State machine | State machine, Idempotency | T-RS-*, T-IDEM-* |
| 19-25. Location | Location | T-LOC-* |
| 26-31. Inbound | Inbound adversarial | T-IN-* |
| 32-36. Reconciliation | Reconciliation | T-RECON-* |
| 37-41. Data model | Unit, Configuration | T-U-*, T-CFG-* |
| 42-45. Cancellation | State machine, E2E, Idempotency | T-RS-*, T-E2E-CANCEL-*, T-IDEM-* |
| 46-48. Crash recovery | Crash | T-CR-* |
| 49-57. Break-glass | Break-glass | T-BG-* |
| 58-60. Provisional cancellation | Break-glass | T-BG-PC-* |
| 61-64. Bootstrap | Bootstrap | T-BS-* |
| 65-67. Canonicalization | Idempotency | T-CAN-* |
| 68-74. Provisional reconciler exactly-once (Rev 3) | Layer 21 | T-PR-EX-*, T-PR-PROP-* |
| 75-77. Pair-coalescing (Rev 3) | Layer 23 | T-PC-* |
| 78. Cancellation acknowledgment (Rev 3) | Layer 25 | T-CACK-* |
| 79. Employee deleted at HCM during reconciliation (Rev 3.1) | Layer 21 | T-PR-EX-12, T-PR-EX-13 |
| 80. History-query window exclusion (Rev 3.1) | Layer 21 | T-PR-EX-14, T-PR-EX-15 |

Every TRD §15 case (1-80) has at least one identified test.

---

## 28. Why this composition is best

The composition is designed so each layer covers exactly what no other layer does, and so no class of regression is uncovered. The 24 layers correspond to 24 classes of regression; removing any one creates a specific blind spot.

**The three layers added in Revision 2 each have a specific raison d'être:**

- **Layer 17 (Mock HCM internal):** Prevents the testing infrastructure itself from being a source of false confidence. The Mock HCM is the test surface for 5 other layers (failure injection, E2E, crash recovery, contract, inbound adversarial). A bug in the mock would compromise all of them. Layer 17 catches mock bugs.

- **Layer 18 (Break-glass):** The break-glass mechanism is the largest new feature in Revision 2 and introduces the most novel state transitions (PROVISIONALLY_APPROVED, ESCALATED_TO_HR). Without dedicated coverage, subtle break-glass bugs (wrong role check, wrong outage threshold, wrong reconciliation order) would only surface in rare production scenarios where they would be most damaging.

- **Layer 19 (Bootstrap):** The three-path bootstrap design is correct only if all three paths handle the race conditions properly. Without dedicated coverage, race-window bugs would only surface during rare timing scenarios.

**The five layers added in Revision 3 each have a specific raison d'être:**

- **Layer 21 (Provisional Reconciler Exactly-Once):** The reconciler is the keystone of the audit story — its correctness is what allows us to claim exactly-once execution at the system boundary. The pre-flight history query, the step log, and the crash-recovery semantics are subtle; the property-based tests in particular guard against interleavings that example-based tests systematically miss. Without this layer, the strongest claim the system makes is unverified.

- **Layer 22 (HR Review Queue):** The HR-facing surface is the operational data feed for irregularities. Without dedicated coverage, the queue could silently drop categories or surface stale items, and the HR team would either miss problems or chase ghosts. Both failure modes are operationally expensive.

- **Layer 23 (Pair-Coalescing):** Pair-coalescing is both an optimization and a correctness mechanism (avoiding partial-failure scenarios in opposing-action reconciliation). Bugs here would either double HCM calls (efficiency loss) or fail to coalesce when needed (correctness regression). The state machine prevents most pathological cases, but the coalescing logic itself needs verification.

- **Layer 24 (MockHcmTestHarness self-tests):** The harness is testing infrastructure — it's not part of the production deployable, but it sits between every test and the system under test. A bug in the harness manifests as misleading test failures across many layers. Self-testing the harness keeps the rest of the suite trustworthy.

- **Layer 25 (Cancellation Acknowledgment Contract):** The flag is the contract between server and UI for an important UX behavior (warning before provisional cancellation). Without dedicated tests, the contract degrades silently if the field is forgotten in any code path.

**The remaining 19 layers** (1-20) retain their prior rationale. The 24-layer test composition is designed so:
- No two layers test the same thing (no redundancy in protection).
- No class of regression is uncovered by any layer (no gap).
- The pyramid shape keeps feedback loops fast.
- Critical/most-novel logic gets disproportionate coverage (property-based, mutation, layer-21 dedicated).

---

## 29. Tooling

| Concern | Tool | Why |
|---|---|---|
| Test runner | Jest | NestJS native |
| Property-based | fast-check | TypeScript-native, expressive shrinking |
| Mutation testing | Stryker | Industry standard for JS/TS |
| HTTP mocking | Real Mock HCM Nest app with own SQLite | Per brief; deployable; verifiable state |
| In-process mocking | Custom InProcessMockAdapter | Faster than HTTP for integration |
| Schema validation | zod | Type-safe; reusable in tests and prod |
| Coverage | Jest istanbul | Built-in |
| Decimal | decimal.js | (ADR-013) |
| CI orchestration | GitHub Actions (assumed) | Boundary-defined |

---

## 30. Coverage Targets

| Metric | Target | Actual | Enforced |
|---|---|---|---|
| Statement coverage (overall) | ≥ 90% | 94.76% | CI gate via [jest.config.ts](../jest.config.ts) |
| Branch coverage (overall) | ≥ 70% | 81.43% | CI gate via [jest.config.ts](../jest.config.ts) |
| Statement coverage (critical modules) | ≥ 95% | 95–100% per dir | CI gate (per-directory `coverageThreshold`) |
| Branch coverage (critical modules) | ≥ 90% (target) | 86.08% aggregate; 10 of 17 dirs ≥ 90% | CI gate per-dir at currently-achieved levels (80–95%); 90% is the aspirational target |
| Mutation kill rate (overall) | ≥ 75% | 75.38% | Stryker `thresholds.break: 75` |
| Property-based runs per property | ≥ 1000 | 1000 | Test config (`NUM_RUNS` in [properties.spec.ts](../apps/service/test/property/properties.spec.ts)) |
| All adversarial modes tested | 100% (9 / 9) | 9 / 9 | Test enumeration |
| All TRD §15 edge cases (1-80) | 100% | 80 / 80 | Traceability matrix above |

Critical modules: `BalanceService`, `RequestService`, `HcmResponseValidator`, `EmploymentService`, `IdempotencyService`, `OutboxWorker`, `Reconciler`, `HcmHealthMonitor`, `BreakGlassAuthorizer`, `ProvisionalReconciler` (Rev 3 — exactly-once is the keystone claim), `CanonicalInputSerializer`, `EmployeeBootstrapService`, `ProvisionalActionRepository` (Rev 3 — append-only enforcement; Rev 3.1 expanded allow-list), `ReconciliationStepRepository` (Rev 3 — append-only enforcement), `ReconcilerLeaseRepository` (Rev 3.1 — lock primitive), `HrReviewQueueService` (Rev 3 — operational data feed; Rev 3.1 paginated), `MockHcmTestHarness` (Rev 3 — testing infrastructure must be trustworthy).

---

## 31. CI Integration

Implemented as two GitHub Actions workflows. Each step is a true gate — failure stops the chain.

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — runs on every PR + push to main, 15-minute budget:

1. Typecheck — `npm run typecheck`
2. Unit (Layer 1) — filtered jest, 37 suites / 527 tests
3. Integration (Layer 2) — `*.integration.spec.ts`, 22 tests
4. Mock HCM internal (Layer 17) — `apps/mock-hcm/src/**`, 32 tests — runs early; a broken mock makes higher layers meaningless
5. MockHcmTestHarness self-tests (Layer 24) — `apps/service/test/helpers/`, 33 tests — runs immediately after Layer 17; a broken harness misleads every higher-layer test
6. Property-based (Layer 4) — `apps/service/test/property/`, 14 properties × 1000 runs
7. Rev 3.1 + adversarial layers (5, 6, 21, 22, 23, 25) — 8 suites, 145 tests
8. E2E (Layer 3) + coverage gate — full suite (785 tests) via `npm run test:coverage`; jest `coverageThreshold` enforces the §30 numbers

[`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml) — runs on push to main + nightly cron (07:00 UTC) + `workflow_dispatch`:

9. Mutation testing (Layer 9) on the 23 mutated files in [stryker.config.json](../stryker.config.json) — `npm run test:mutation`, ~23 min, `break: 75`. Reports uploaded as workflow artifacts.

Flaky tests fail the build until the underlying determinism issue is fixed.

**Ordering rationale.** Layers 17 and 24 are infrastructure-of-tests. Both run before Layer 18+: a broken mock or broken harness produces false confidence everywhere else. The dedicated Rev 3 layers (21-25) run after property-based because property-based shakes out the most subtle interleavings — Layer 21's property tests in particular are non-trivial and benefit from being grouped with their kin.
