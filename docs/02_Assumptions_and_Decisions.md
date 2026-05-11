# Assumptions, Decisions, and Tradeoff Analysis

**Status:** Revision 3.1
**Companion to:** `00_Cover_and_Reasoning.md`, `01_TRD.md`, `03_Test_Plan.md`, `04_Module_Plan.md`

This document captures every meaningful assumption made during design, the alternatives considered for major decisions, and the reasoning that selected the chosen approach.

---

## CHANGELOG (since Revision 3)

Rev 3.1 closes six open questions from Rev 3 review. No new architecture; refinements documented as ADRs 022–027.

- **ADR-022 (NEW, Q.θ):** `ProvisionalAction.localStateSnapshot` retention — full snapshot on insert; summarized on success/no-op; retained in full only for escalations.
- **ADR-023 (NEW, Q.ι):** `ReconcilerLease` table — row-based advisory lock primitive for the provisional reconciler.
- **ADR-024 (NEW, Q.κ):** Pre-flight HCM history-query window default of 24 hours, configurable.
- **ADR-025 (NEW, Q.λ):** Stale-provisional-action signals — both durable audit events AND a sampled metric gauge.
- **ADR-026 (NEW, Q.μ):** HR Review Queue uses Relay-style cursor pagination matching the rest of the GraphQL surface.
- **ADR-027 (NEW, Q.ν):** `EMPLOYEE_NOT_FOUND_AT_HCM` reconciliation outcome — escalate to HR with explicit reason; new `ReconciliationStepKind`.
- **Assumptions 73-80 (NEW):** Rev 3.1 specifics.

---

## CHANGELOG (since Revision 2)

- **ADR-016 (NEW, Q.α):** Cancellation-during-outage requires `acknowledgedHcmUnavailable: true`. Server cannot verify UI but contracts the flag. Audit logs the assertion. Documented as a UI-server-boundary assumption.
- **ADR-017 (NEW, Q.β):** `PROVISIONALLY_APPROVED → TAKEN` with `hrReviewFlag` rather than blocking the transition or introducing a distinct `TAKEN_UNRECONCILED` state. The leave happened in the real world; our state machine reflects that. HR Review Queue surfaces irregularities.
- **ADR-018 (NEW, Q.γ):** Provisional reconciler is formalized with mandatory pre-flight HCM transaction-history query, ProvisionalAction.id as outbound idempotency key, and per-step `ReconciliationStep` event log. The combination provides exactly-once execution semantics at the system boundary, verifiable from audit log alone.
- **ADR-019 (NEW, Q.δ):** `ProvisionalAction` and `ReconciliationStep` are append-only with explicit conventions enforced at repository layer. `ProvisionalAction` allows updates only on the three reconciliation fields. `ReconciliationStep` allows no updates at all. SQLite triggers may belt-and-suspenders.
- **ADR-020 (NEW, Q.ε):** `MockHcmTestHarness` centralizes all test-side interactions with the mock. Required by every test layer that touches the mock. Tested as a deliverable. Replaces ad-hoc per-test admin HTTP calls.
- **ADR-021 (NEW, Q.ζ):** Pair-coalescing of opposing provisional actions (approval + cancellation on the same request during the same outage). Both marked NO_OP without HCM calls; audit chain preserved via `PROVISIONAL_PAIR_COALESCED` event.
- **ADR-009 (UPDATED):** Reconciliation cadence summary updated to reference the formalized provisional reconciler.
- **Assumptions 59-72 (NEW):** Added assumptions specific to Rev 3 decisions.
- **Alternatives Q-W (NEW):** Documented and rejected alternatives explored in Rev 3.

---

## CHANGELOG (since Revision 1, preserved)

- **ADR-011:** Break-glass override mechanism for sustained HCM outage.
- **ADR-012:** Employee bootstrap strategy (webhook + lazy pull + batch).
- **ADR-013:** `decimal.js` for all monetary/unit arithmetic, with serialization rules.
- **ADR-014:** Canonical input serializer for idempotency hashing.
- **ADR-015:** Point-read jitter and coalescing.

---

## Part I — Architecture Decision Records

### ADR-001: HCM is dispositive at every commit point that can reach HCM

**Decision.** Every approval, every cancellation, and every other balance-mutating action calls HCM live and treats HCM's response as dispositive — *when HCM is reachable*. Provisional approvals (ADR-011) are the explicit exception for sustained outage; they are reconciled against HCM ground truth on recovery.

**Context.** Stakeholder direction: "Approve a leave request if HCM has enough days, even if our internal system is not in sync." With the break-glass addition: also accept that we will sometimes commit decisions before HCM can validate them, but always reconcile back to HCM truth.

**Alternatives considered.**

1. **Local-arbitrated.** Rejected: local is wrong too often.
2. **Local-cached with HCM verification only on edge cases.** Rejected: asymmetric.
3. **HCM is dispositive when reachable; provisional when not. (Selected.)** Combines correctness when possible with operability when not.

**Why selected.** The original dispositive rule was correct but operationally too strict. The break-glass mechanism preserves the rule's spirit (HCM is the source of truth) while acknowledging operational reality (sustained outages happen).

**Implications.**
- Approval flow consults HCM live and fails closed by default if HCM is unreachable.
- Break-glass override allows authorized approvers to proceed without HCM, with full audit and mandatory reconciliation.
- Concurrency at approval is HCM's problem when reachable; ours (via provisionalHold accounting) when not.
- Throughput is bounded by HCM's RPS when reachable. Acceptable.

---

### ADR-002: Three-axis state model

Unchanged from Revision 1.

**Decision.** Three orthogonal state machines: BalanceState, RequestState, OutboxState. Revision 2 adds `PROVISIONALLY_APPROVED` and `ESCALATED_TO_HR` to RequestState, plus an embedded `reconciliationState` on `ProvisionalAction` rows. The orthogonality holds.

---

### ADR-003: Polling-based outbox in SQLite, not BullMQ + Redis

Unchanged from Revision 1. Full rationale in Revision 1; key points:

1. Atomicity of outbox-with-domain-write in single SQLite transaction.
2. Dependency cost of Redis.
3. Test determinism via `worker.tick()`.
4. Throughput requirements are human-scale.
5. Failure semantics under our control.

---

### ADR-004: Single process, multi-module

Unchanged. SQLite single-writer constraint + exercise scope.

---

### ADR-005: Require HCM transaction confirmation in every mutation response

Unchanged. `transactionId`, `deltaApplied`, `newAvailable`, `hcmVersion`, `appliedAt`. `deltaApplied` is the sound check; arithmetic of `(newAvailable - oldAvailable)` is unsound.

---

### ADR-006: Eager commit on approval, with HCM live verification

Unchanged.

---

### ADR-007: Location transfers in scope, attributed by start date

Unchanged.

---

### ADR-008: Client-supplied idempotency keys on every mutation

Unchanged, extended by ADR-014 (canonical serialization for the hash).

---

### ADR-009: Reconciliation cadence configurable, multiple layers retained

**Updated in Revision 2.** Reconciliation is now six layers (not five): pre-validation, schema/contract validation, transaction-confirmation check, deferred point-read (with jitter + coalescing per ADR-015), drift sweep, batch, and the new provisional reconciliation pass (§9.5.3 of TRD).

**Implications.**
- Configurable cadences per layer.
- Tests assert convergence at each cadence in isolation.
- Provisional reconciliation has its own trigger (HCM recovery event), not a fixed cadence.

---

### ADR-010: GraphQL union-style error model with canonical taxonomy

Unchanged structurally; error code list expanded for break-glass, bootstrap, etc.

---

### ADR-011: Break-glass override for sustained HCM outage (NEW)

**Decision.** Approvals during HCM outage fail closed by default. Authorized approvers with the `break_glass_approver` role may invoke an explicit override after HCM has been unavailable for at least `breakGlassMinOutageMs` (default 60s). Every provisional decision is event-logged in the `ProvisionalAction` table and reconciled against HCM on recovery.

**Cancellations during outage are provisional by default** (no break-glass role required) because they are credit operations with bounded risk if wrong.

**Context.** Stakeholder direction (revised Q-A): "Our system should be able to run still though we definitely need to check against groundtruth. Use the fail-closed-by-default with break-glass override. Event-driven architecture so we can reconcile when HCM is back."

**Alternatives considered.**

1. **Always fail closed (no break-glass).** Pros: simplest. Cons: unacceptable cost during multi-hour outages. *Rejected.*
2. **Always allow provisional (no role gate).** Pros: maximum operability. Cons: too permissive; over-approval risk; insufficient audit. *Rejected.*
3. **Soft-fail with automatic degraded mode.** Pros: no human intervention needed. Cons: implicit; hides the decision; harder to audit; risk of silent over-approval. *Rejected.*
4. **Break-glass with role gate, outage threshold, and event-driven reconciliation. (Selected.)** Pros: explicit, audited, role-gated, time-gated, reconciled. Cons: more states, more code, more tests.

**Why selected.** Aligns operational continuity with the audit trail required for a workforce system. The role gate prevents abuse; the outage threshold prevents premature override on transient hiccups; the event log enables defensible reconciliation.

**Implications.**

- New state: `PROVISIONALLY_APPROVED`. Lifecycle: enters via break-glass; exits to `APPROVED` (HCM confirms) or `ESCALATED_TO_HR` (HCM rejects on recovery).
- New state: `ESCALATED_TO_HR`. Terminal in software; resolved manually by HR.
- New balance hold: `provisionalHold`. Distinct from `pendingHold` and `approvedHold`.
- New table: `ProvisionalAction`. Event-sourced log of every break-glass decision, drained by reconciler on HCM recovery.
- New module: `HcmHealthMonitor`. Tracks reachability with hysteresis (recovery requires `healthRecoveryWindowMs` of consecutive successful checks).
- New mutation: `approveTimeOffRequestProvisionally`.
- New role: `break_glass_approver`.
- New audit events: `BREAK_GLASS_APPROVAL_INVOKED`, `PROVISIONAL_APPROVAL_CONFIRMED`, `PROVISIONAL_APPROVAL_ESCALATED`.
- Worst case scenario (leave taken before HCM ever confirms, then HCM rejects): explicitly designed for. ESCALATED_TO_HR with severity flag; full local-state snapshot at break-glass invocation makes the HR investigation tractable.
- Audit-heavy by design. Every provisional decision is reproducible from its `ProvisionalAction` row.

**Event-driven nature.** The `ProvisionalAction` table is an append-only event log. The reconciler is a consumer that drains pending events when HCM is back. This is event-driven architecture at the boundary between "decisions made without HCM" and "decisions confirmed by HCM" — exactly where the asynchrony is.

---

### ADR-012: Employee bootstrap via webhook (primary) + lazy pull (safety net) + batch (catch-all) (NEW)

**Decision.** Three paths for bootstrapping a new employee into our local projection. Webhook (`EMPLOYEE_CREATED`) is primary. Lazy pull at first API touch is the safety net for missed webhooks. Daily batch is the unconditional convergence path. All three update the same `Employee` table; all are idempotent.

**Context.** New hires must be able to use the system soon after joining HCM. Without an explicit bootstrap flow, first-touch failures would manifest as cryptic dimension errors.

**Alternatives considered.**

1. **Webhook only.** Pros: simple, fast. Cons: lossy. Missed webhook = employee can't use system until daily batch (~24h). Rejected as sole mechanism.
2. **Batch only.** Pros: simplest. Cons: 24h latency unacceptable for new hires. Rejected as sole mechanism.
3. **Lazy pull only.** Pros: always correct on first touch. Cons: HCM unavailable at first touch = employee can't use the system at all. Rejected as sole mechanism.
4. **All three together. (Selected.)** Layered defense: any one path can fail and the others converge correctly.

**Why selected.** Same philosophy as the reconciliation strategy: defense in depth. Each path covers a different failure mode.

- Webhook covers the happy path (HCM signals → we receive → we project).
- Lazy pull covers webhook loss (we discover the gap when needed).
- Batch covers prolonged outage of both above (eventually correct within 24h).

**Implications.**

- New module: `EmployeeBootstrapService`.
- New table: `Employee` (one row per known employee; absence triggers lazy pull).
- New event type in inbox: `EMPLOYEE_CREATED`.
- New error code: `EMPLOYEE_NOT_BOOTSTRAPPED` (lazy pull failed because HCM unreachable and HCM has no record of the employee).
- All employee-referencing operations begin with `ensureBootstrapped(employeeId)`.
- Race condition between webhook arrival and lazy pull starting: both are idempotent on insert (use `INSERT OR IGNORE` or equivalent), so concurrent bootstraps merge cleanly.

---

### ADR-013: `decimal.js` for all monetary/unit arithmetic (NEW)

**Decision.** All units (request units, balance available, holds, deltas) use `decimal.js` `Decimal` objects internally. Serialization rules: GraphQL custom scalar string, SQLite `TEXT` column, HCM contract responses validated as strings then parsed.

**Context.** JavaScript's native `number` is IEEE 754 binary float. `0.1 + 0.2 !== 0.3`. Unacceptable for unit accounting that must reconcile against HCM. Even days-only (no decimals) leave can produce float surprises through repeated arithmetic.

**Alternatives considered.**

1. **Native `number`.** Pros: trivial. Cons: float precision bugs. Rejected.
2. **Integer cents/thousandths.** Pros: also avoids floats. Cons: precision must be agreed everywhere; conversion errors; less readable in logs. Rejected.
3. **`big.js`.** Pros: smaller library. Cons: fewer features; API less ergonomic. Rejected.
4. **`bignumber.js`.** Pros: similar to decimal.js. Cons: marginally less common; older API patterns. Rejected.
5. **`decimal.js`. (Selected.)** Pros: widely used, well-maintained, expressive API, supports configurable precision, sound comparisons (`.cmp()`). Cons: external dependency, slight perf overhead vs. native.

**Why selected.** Ergonomic, correct, common. The performance cost is irrelevant for our workload (we're not number-crunching).

**Implications.**

- All domain code uses `Decimal`, never `number`.
- GraphQL `Decimal` scalar serializes to/from string. Tests verify no `number` round-trip ever happens.
- SQLite `TEXT` for Decimal columns. Custom TypeORM transformer parses on read, serializes on write.
- Comparisons via `.cmp()`, `.eq()`, never `==` or `===`.
- HCM responses validated: Decimal fields are strings; if HCM ever returns numeric, schema validation rejects (preserves contract).
- Precision per leave type via `policy.leaveTypePrecision` (default 2 — supports half-day granularity at 0.5).

---

### ADR-014: Canonical input serializer for idempotency hashing (NEW)

**Decision.** Idempotency `inputHash` is computed by canonicalizing the input through a strict, documented set of transformations before hashing. Rules in TRD §14.4.

**Context.** Without canonicalization, semantically identical inputs can produce different hashes due to field order, decimal formatting, date string variations, or Unicode normalization. This makes idempotency fragile: a legitimate retry from a client (where the underlying value is unchanged but the JSON serialization differs by a byte) would be misclassified as a new request *or* a collision.

**Alternatives considered.**

1. **Hash raw bytes as received.** Pros: simplest. Cons: every ambiguity above produces false negatives or false collisions. Rejected.
2. **Define a strict input schema and reject anything not byte-canonical.** Pros: no canonicalizer needed. Cons: forces clients to canonicalize, which is brittle; passing through middleboxes (JSON parsers, proxies) can perturb bytes. Rejected.
3. **Canonicalize before hashing. (Selected.)** Pros: clients send any reasonable representation; we collapse to canonical form internally. Cons: must specify canonicalization carefully; tests must cover every ambiguity.

**Why selected.** Robust to client variation; deterministic for our purposes.

**Canonicalization rules** (TRD §14.4 has the full spec):

1. JSON keys sorted lexicographically.
2. No whitespace in serialized output.
3. Strings normalized to NFC.
4. Dates collapsed to ISO-8601 UTC. Date-only fields drop time entirely.
5. Decimals parsed and re-serialized via `toFixed(precision)` per leave type.
6. Booleans, nulls as JSON literals.
7. Arrays preserve order (semantic); elements canonicalized recursively.
8. Unknown extra fields stripped (forward-compat).
9. SHA-256 of canonical bytes.

**Implications.**

- `CanonicalInputSerializer` is a small but critical service with its own dedicated tests for each rule.
- Tests cover the four explicit ambiguities (date formats, decimal formats, field order, Unicode) and combinations.
- Forward-compat: adding optional fields to input schema doesn't invalidate existing keys.
- Tradeoff: serialization is slightly slower (negligible, ~microseconds), but correctness is paramount.

---

### ADR-015: Point-read jitter and coalescing (NEW)

**Decision.** Deferred point-reads after successful HCM commits are scheduled with random jitter to spread time-correlated reads, and coalesced per-balance to deduplicate redundant scheduled reads. A steady-rate drain bounds total HCM call volume regardless of input burst.

**Context.** The original design scheduled point-reads exactly `pointReadDelayMs` after commit. A burst of 1000 commits in one second would produce 1000 point-reads simultaneously 30 seconds later — a self-inflicted DDoS on HCM.

**Alternatives considered.**

1. **No point-reads.** Pros: simplest. Cons: loses a defensive layer. Rejected.
2. **Jitter only.** Pros: simple. Cons: doesn't bound rate; spread but not capped. Insufficient for sustained bursts.
3. **Coalescing only.** Pros: deduplicates. Cons: doesn't help when 1000 distinct balances each need verification. Insufficient.
4. **Jitter + coalescing + steady-rate drain. (Selected.)** Each addresses a different failure mode.

**Why selected.** Each component is small (< 50 lines), and together they protect HCM from the bursty-write patterns that are typical when humans approve in batches at start of workday.

**Implications.**

- `PointReadScheduler` maintains an in-memory map of scheduled reads, deduplicated per `(emp, loc, type)`.
- `PointReadDrainer` consumes the schedule at a configurable rate.
- Tests verify: jitter spreads over the configured window; coalescing drops duplicate schedules; drainer respects the rate limit; under sustained burst, no point-read is *lost* — only deduplicated.

---

### ADR-016: Cancellation-during-outage requires `acknowledgedHcmUnavailable: true` (NEW, Q.α)

**Decision.** When a cancellation of an APPROVED request is submitted while HCM is unavailable, the API mutation requires the input field `acknowledgedHcmUnavailable: true`. If absent, the mutation fails with `CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT`. The flag's purpose is to contract the UI's warning rendering. The server does not (cannot) directly verify UI behavior, but the flag is mandatorily recorded in the audit event for the provisional cancellation.

**Context.** Provisional cancellation does not require a break-glass role (cancellation is a credit operation with bounded downside). However, the user should still understand that the cancellation is provisional and may take time. We needed a contract between server and UI to ensure the warning was rendered.

**Alternatives considered.**

1. **No flag; trust the UI to do the right thing.** Pros: simplest. Cons: any UI bug or third-party client could silently skip the warning. Rejected.
2. **Require a justification text field (like break-glass).** Pros: maximally explicit. Cons: user friction; cancellation is supposed to be easy. Rejected.
3. **Server-side warning via two-phase API: first call returns warning + a `proceedToken`, second call consumes the token.** Pros: server-mediated. Cons: two round-trips, more state. Over-engineered for what is essentially a UI contract. Rejected.
4. **Single boolean acknowledgment flag in input. (Selected.)** Pros: minimal friction; explicit contract; recordable in audit. Cons: server can't verify the UI actually rendered the warning.

**Why selected.** Lightweight, explicit, auditable. The server's job is to enforce the contract; the UI's job is to honor it. A buggy UI is a bug to fix on the UI side, not a vulnerability in the server's correctness model.

**Assumption documented.** This is fundamentally a trust boundary: we trust the UI to render the warning when it sets the flag. If a UI is found to set the flag without rendering, that's a UI bug — auditable from logs but not preventable server-side.

**Implications.**
- New error code `CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT`.
- Audit event for every provisional cancellation includes `acknowledgmentFlag: true` and the actor.
- The flag has no effect when HCM is healthy; it's just ignored (forward-compat for UIs that always send it).
- Tests cover both with-flag and without-flag during outage.

---

### ADR-017: PROVISIONALLY_APPROVED → TAKEN with hrReviewFlag (NEW, Q.β)

**Decision.** When a request that was approved provisionally has its leave date pass before HCM reconciles, and reconciliation eventually fails, the request transitions to `TAKEN` with `hrReviewFlag = true` and an `hrReviewReason` populated. It surfaces in the HR Review Queue via the `hrReviewQueue` GraphQL query.

**Context.** The worst case for break-glass is: provisional approval granted, employee takes the leave, then HCM rejects on reconciliation. Software cannot un-take the leave. The question is how to represent the situation.

**Alternatives considered.**

1. **TAKEN with hrReviewFlag. (Selected.)** Reflects reality: leave was taken. Flag surfaces the irregularity. Minimal state-machine impact.
2. **Block the `PROVISIONALLY_APPROVED → TAKEN` transition.** Pros: prevents the awkward state. Cons: the leave happened. Our refusing to transition is fiction.
3. **Distinct `TAKEN_UNRECONCILED` state.** Pros: dashboards can split TAKEN cases. Cons: more state-machine surface; flag accomplishes the same surfacing with less complexity.
4. **ESCALATED_TO_HR even after the leave was taken.** Pros: consistent with pre-leave-date rejections. Cons: confuses dashboards — leave was taken, but state says it never got past escalation.

**Why selected.** Option (1) is honest. The state machine reflects what happened, and the flag plus the HR Review Queue make the irregularity visible without forcing every downstream consumer to special-case a new state.

**Trade-off.** `TAKEN` is no longer strictly "happy terminal" — it can carry a flag. We document this loudly in the TRD so dashboards and reports do not assume `TAKEN` means "everything fine." Future product requirement could justify the split-state (alternative 3); refactoring then is low-risk.

**Implications.**
- `request.hrReviewFlag` boolean (default false) and `request.hrReviewReason` string field.
- `hrReviewQueue` GraphQL query exposes three categories: pre-leave escalations, post-leave HR-flag, and stuck cancellations.
- HR Review Queue is documented as the operational surface for these cases. The HR-facing UI is out of scope (boundary in §19); the data feed is in scope.
- Audit chain remains intact: from the `TAKEN` row, you can walk to the `ProvisionalAction` row and the full `ReconciliationStep` log.

---

### ADR-018: Provisional reconciler with pre-flight history query and event log (NEW, Q.γ)

**Decision.** The provisional reconciler performs three durable steps for every pending `ProvisionalAction`:

1. **Pre-flight HCM transaction-history query** with the ProvisionalAction.id as filter.
2. **Skip or call** based on the history query result.
3. **Apply outcome** atomically with the `ReconciliationStep` log entry.

Each step is recorded as a row in `ReconciliationStep`. The combination provides exactly-once execution semantics: each provisional action causes at most one HCM debit/credit, and the audit chain proves it.

**Context.** Naïve reconciliation (just call reserveBalance with the original idempotency key) is correct only if HCM honors keys perfectly AND we never lose our state. Both assumptions fail in practice: HCM vendors vary in their idempotency support, and our reconciler can crash mid-call.

**Alternatives considered.**

1. **Naïve reserve-with-key.** Pros: simple. Cons: depends on HCM honoring keys; no protection if our state is lost mid-call. Rejected as unsafe.
2. **Reserve-with-key plus our own retry tracking (no history query).** Pros: better. Cons: still relies on HCM's key honoring; no defense against an HCM vendor that ignores keys. Rejected.
3. **Pre-flight history query + reserve-with-key + step log. (Selected.)** Three layers; any one functioning gives correctness.
4. **Pre-flight history query + serialization through outbox.** Pros: shared retry infrastructure with normal HCM calls. Cons: the reconciler does need different decision logic per step, so it can't be just an outbox entry. The outbox is still used for the actual HCM call, but the *orchestration* lives in the reconciler.

**Why selected.** Each layer addresses a distinct failure mode: history query catches pre-existing HCM application; idempotency key catches HCM-honoring duplicate detection; step log catches our crash mid-call. The combination makes exactly-once auditable.

**Implications.**
- New table `ReconciliationStep` (append-only).
- HCM port adds `queryTransactions(query)` method.
- Mock HCM implements `queryTransactions` natively.
- Real adapters that don't natively support history queries must synthesize via per-tenant transaction log. Adapters that cannot do this are flagged as "best-effort exactly-once."
- Tests verify all branches: pre-existing transaction found, mismatched delta found, no transaction found, history query fails.

**Event-driven architecture.** This is the cleanest realization of event-driven design in the system. The `ProvisionalAction` is the decision-event; the `ReconciliationStep` rows are execution-events; the audit trail is a sequence of events. The reconciler is a stateless consumer that reads its own prior events to decide where to resume.

---

### ADR-019: Append-only event log convention enforced at repository (NEW, Q.δ)

**Decision.** `ProvisionalAction` allows updates only on a closed allow-list of three fields (`reconciliationState`, `reconciledAt`, `reconciliationDetails`). `ReconciliationStep` allows no updates at all. Both prohibit deletes. Enforcement is at the repository layer with optional SQLite trigger as belt-and-suspenders.

**Context.** Both tables are described as "event logs." Without enforcement, "event log" is just documentation. Real protection comes from making the code that mutates them small and reviewable.

**Alternatives considered.**

1. **Strict append-only — no updates at all on either table.** Pros: cleanest event-sourcing. Cons: reconciliation outcomes need to be queried efficiently; would require either an additional table or a "current state" projection. Doubles the schema. Rejected as over-engineered for this scope.
2. **No convention — any update allowed.** Pros: simplest schema. Cons: "event log" is a lie; anything can be retroactively rewritten. Defeats the audit story. Rejected.
3. **Repository-level allow-list. (Selected.)** Repository exposes only specific methods (`insert`, `markReconciled`). No generic `update`. Defensive.
4. **Database-trigger enforcement.** Pros: belt-and-suspenders. Cons: adds migration complexity; harder to evolve schema. *Optional* — can be added without breaking the repository contract.

**Why selected.** (3) is sufficient for our scope and easy to verify (small repository surface). (4) is available as a hardening option if compliance requires it later.

**Implications.**
- `ProvisionalActionRepository` has methods `insert(row)` and `markReconciled(actionId, finalState, details)`. No `update`. No `delete`.
- `ReconciliationStepRepository` has method `insert(row)`. No update, no delete.
- Tests verify the methods exist and refuse off-allow-list updates.
- Schema migrations include the option to add triggers as a separate migration step.

**Event-driven implications.** The append-only convention is what makes the rest of the event-driven architecture work. If reconciliation outcomes could be rewritten, the audit chain would be unreliable. The convention is load-bearing.

---

### ADR-020: MockHcmTestHarness centralizes test-mock interactions (NEW, Q.ε)

**Decision.** Tests interact with the Mock HCM exclusively through a typed harness class `MockHcmTestHarness`. The harness encapsulates state reset, seeding, mode setting, reachability control, scheduling, and assertions. Per-test admin HTTP calls are forbidden by convention; test code uses harness methods.

**Context.** The Mock HCM has nine modes, dozens of admin endpoints, durable state, scheduled events, and webhook firing controls. Without centralization, each test layer reimplements the same setup; small variations introduce flake; mock contract changes propagate to every test.

**Alternatives considered.**

1. **Per-test admin HTTP calls.** Pros: no abstraction; explicit. Cons: drift, duplication, maintenance burden. Rejected.
2. **Helper functions per concern (resetHcm(), seedBalance(), etc.).** Pros: lightweight. Cons: stateless helpers can't manage connection or per-suite lifecycle cleanly. Insufficient.
3. **Typed harness class with lifecycle and encapsulated state. (Selected.)** Pros: single seam, clear lifecycle, typed, documented. Cons: another piece of code to write and test.
4. **Inline the mock as a Nest module in the same process.** Pros: no HTTP, no separate process. Cons: defeats the point of treating HCM as remote; couples crash-recovery tests poorly. Rejected.

**Why selected.** A complex test surface requires a clean abstraction at the test boundary. The harness is the abstraction. Its own correctness is tested separately.

**Implications.**
- `MockHcmTestHarness` is a deliverable in the test infrastructure (Layer 24 in `03_Test_Plan.md`).
- All test layers that touch the mock import and use the harness.
- Mock-contract changes (new admin endpoints, new modes) update one file: the harness.
- The harness has TSDoc on every method referencing the TRD section that specifies the behavior.

---

### ADR-021: Provisional action pair-coalescing (NEW, Q.ζ)

**Decision.** The provisional reconciler runs a pair-coalescing pass before issuing any HCM calls. Opposing `ProvisionalAction` rows on the same request during the same outage window (one `BREAK_GLASS_APPROVAL` and one `PROVISIONAL_CANCELLATION`) are recognized as a pair, marked `NO_OP` on both, and the request transitions directly to `CANCELLED`. No HCM call is made for these actions. An audit event `PROVISIONAL_PAIR_COALESCED` records the rationale.

**Context.** If an employee is approved provisionally and then cancels, then HCM recovers, the naïve reconciler would call reserveBalance (succeed) then releaseBalance (succeed) — two HCM calls and two transactions for what is effectively no change. Worse: if either call fails, we'd be in a partial state requiring complex compensating logic.

**Alternatives considered.**

1. **Issue both calls (no coalescing).** Pros: simple. Cons: wasteful; doubles HCM call volume on a common scenario; produces transaction-history noise; failure-mode complexity. Rejected.
2. **Coalesce pairs. (Selected.)** Pros: efficient, simpler failure mode (no call to fail), cleaner audit trail. Cons: requires the coalescing pass logic.
3. **Coalesce arbitrary chains (approve, cancel, approve, ...).** Pros: covers all variants. Cons: arbitrary chains are forbidden by state machine (you can't re-approve after cancelling); the simple pair case covers all reachable scenarios.

**Why selected.** Real correctness improvement plus efficiency. The state machine already prevents arbitrary chains, so simple pair-coalescing is sufficient.

**Implications.**
- `ProvisionalReconciler.drain()` begins with a coalescing pass.
- Both action rows persist with `reconciliationState = NO_OP`; nothing is hidden.
- A `PROVISIONAL_PAIR_COALESCED` audit event records the decision and ties the two actions together.
- Tests cover the four orderings:
  - approval-then-cancellation (the common case): both NO_OP.
  - cancellation-then-approval (state machine prevents this; tested as rejected).
  - double approval (state machine prevents).
  - double cancellation (second is idempotent NO_OP).

**Audit chain.** All actions remain logged. No row is deleted or hidden. The audit event ties them together with explicit rationale.

---

### ADR-022: ProvisionalAction snapshot retention — summarize on success, retain in full on escalation (NEW in Rev 3.1, Q.θ)

**Decision.** `ProvisionalAction.localStateSnapshot` carries the full balance + request + employment + leave-type state at break-glass invocation. On reconciliation success or NO_OP, the snapshot is replaced with a compact `localStateSnapshotSummary` (~200 bytes). On ESCALATED outcomes, the full snapshot is retained indefinitely.

**Context.** The snapshot is essential for HR investigation when reconciliation fails — but for the common case (reconciliation succeeds), it's storage growth nobody will ever read.

**Alternatives considered.**

1. **Always keep full snapshot indefinitely.** Pros: simplest; maximum forensic capability. Cons: unbounded storage growth; most snapshots never read. *Rejected* for the default case.
2. **Always summarize after reconciliation.** Pros: minimal storage. Cons: loses forensic capability on escalated cases, exactly where it's needed most. *Rejected.*
3. **Summarize on success, retain on escalation. (Selected.)** Pros: storage bounded for the common path; full data retained where HR will actually look. Cons: two retention rules to remember; one more allow-listed field on `markReconciled`.
4. **Archive to cold storage table after N days.** Pros: complete history kept. Cons: operational complexity; archival scheduler. Future work; reasonable next step after Rev 3.1 if storage becomes the bottleneck.

**Why selected.** The retention policy matches the access pattern. Investigators look at escalations; nobody reads CONFIRMED snapshots.

**Implications.**

- `ProvisionalAction.localStateSnapshot` becomes nullable.
- New column `localStateSnapshotSummary: json?`.
- `markReconciled` allow-list grows from 3 to 5 fields: `reconciliationState`, `reconciledAt`, `reconciliationDetails`, `localStateSnapshot` (null on success/no-op only), `localStateSnapshotSummary`.
- Append-only repository convention extended; the additional mutations are still through the single allow-listed method.
- Configuration knob `reconciler.snapshotRetention.summarizeAfterSuccess` (default true) gates the behavior. Compliance-heavy deployments may disable it.
- Audit chain unaffected — the audit event was always the canonical record.
- Test obligation: verify the summary is produced; verify the full snapshot is retained on escalation; verify the configuration knob actually disables summarization.

**Risk.** Edge case: a CONFIRMED action is later disputed and someone wants the original snapshot. Mitigation: the `localStateSnapshotSummary` preserves the structural decision data (balance hash, request IDs, decision metadata); the audit chain holds the rest. Acceptable.

---

### ADR-023: ReconcilerLease table for advisory locking (NEW in Rev 3.1, Q.ι)

**Decision.** The provisional reconciler's mutual exclusion uses a single-row `ReconcilerLease` table (`id='provisional'`) with `heldBy`, `acquiredAt`, `expiresAt`. Acquisition is a single atomic `UPDATE ... WHERE heldBy IS NULL OR expiresAt < ? RETURNING *`.

**Context.** Multiple worker instances (or buggy retries) must not run reconciliation concurrently — the pre-flight history query plus call sequence is not safe under concurrent execution. We need a lock primitive that survives crashes.

**Alternatives considered.**

1. **`BEGIN EXCLUSIVE` for the whole reconciliation tick.** Pros: zero application code. Cons: opaque (can't see who's holding the lock); blocks all writes to the SQLite database for the duration; crash safety relies on connection close detection.
2. **Application-level mutex (in-memory).** Pros: trivial. Cons: only works in single-process; we need to defend against multi-process even though current deployment is single-process (future work).
3. **Row-based lease with TTL. (Selected.)** Pros: debuggable (`SELECT * FROM reconciler_lease` shows the state); crash-safe (TTL expiration releases stale locks); portable to Postgres (replace primitive with `pg_advisory_lock` if desired).
4. **Filesystem flock.** Pros: simple. Cons: doesn't compose with the database transactions we already use; not portable to Postgres.

**Why selected.** Debuggability is undervalued. An ops person should be able to ask "is the reconciler running?" and get an answer by reading a single row. The TTL handles crashes without operational intervention. The Postgres migration path is clean (`pg_advisory_lock`).

**Implications.**

- New table `ReconcilerLease`.
- New module/file `apps/service/src/reconciliation/provisional/advisory-lock.ts`.
- Migration creates the table and seeds the single row `id='provisional', heldBy=null`.
- `reconciler.leaseTtlMs` defaults to 60 seconds. Any reconciliation tick that would run longer than this is anomalous and should be investigated.
- A tick that crashes leaves the lease "abandoned" until `expiresAt` passes; subsequent tick steals it via the `expiresAt < ?` predicate. No human intervention needed for normal crash recovery.
- Test obligation: concurrent reconciler ticks (one wins, one skips); crash-mid-tick (next tick proceeds after TTL); release uses `heldBy = ?` predicate to prevent foreign release.

**Postgres migration.** Replace the row-based lease with `pg_advisory_lock('provisional-reconciler')`. Session-scoped; auto-released on disconnect. The reconciler service interface stays the same shape; the underlying primitive changes. Documented in `00_Cover_and_Reasoning.md §12`.

---

### ADR-024: Pre-flight history-query window default 24h (NEW in Rev 3.1, Q.κ)

**Decision.** The provisional reconciler's pre-flight `queryTransactions` call uses a window of `[action.invokedAt - reconciler.historyQueryWindowMs, now()]`. Default `historyQueryWindowMs` is 24 hours, configurable.

**Context.** The window must be wide enough to capture any transaction HCM might have applied on behalf of this action — including transactions applied during the outage that we didn't see, transactions applied by previous reconciler attempts, or transactions applied via out-of-band recovery. But too wide and the query returns more data than necessary; too narrow and we miss transactions outside the window (correctness gap — but bounded by HCM's own idempotency-key handling, which still dedupes).

**Alternatives considered.**

1. **1 hour.** Pros: tight scoping; smallest queries. Cons: insufficient for multi-hour outages followed by reconciler delay. Earlier draft used this; it's too narrow.
2. **24 hours. (Selected.)** Pros: covers any plausible single outage; matches the daily batch reconciliation cadence so the longest reasonable gap is closed by Layer 7 reconciliation anyway. Cons: returns more data than absolutely necessary; idempotency-key filter narrows it.
3. **7 days.** Pros: maximum safety margin. Cons: queries return more data; in real HCM systems with high transaction volume, this becomes noticeable.
4. **Unbounded.** Pros: never miss anything. Cons: HCM's query performance degrades; defeats the purpose of narrowing.

**Why selected.** 24h matches the maximum useful reconciler delay (anything longer is caught by the daily batch backstop), and the idempotency-key filter means even with a wider window we only see transactions tagged with our specific action IDs. The configurability lets operators with longer expected outages widen it.

**Implications.**

- `HcmPort.queryTransactions` accepts a `window` parameter.
- `MockHcmTestHarness` exposes seeding helpers to insert transactions with specific timestamps for testing the window boundary.
- Test obligation (TRD edge case 80): transactions inside the window are seen; transactions outside the window are not seen; the HCM idempotency-key check still catches duplicates correctly when we issue a fresh call.

**Risk.** A real HCM outage longer than 24h combined with reconciler delay >24h could place the window before any transaction HCM applied. In that case, the reconciler issues a fresh call with the same idempotency key; HCM's own idempotency handling dedupes (assuming the contract holds). Layer 7 daily reconciliation also runs daily and would catch any resulting drift.

---

### ADR-025: Stale-provisional-action signals — audit event AND metric gauge (NEW in Rev 3.1, Q.λ)

**Decision.** When a `ProvisionalAction` has been `PENDING` for longer than `provisionalActionStaleAlertMs` (default 4h), the reconciler emits two signals on every tick:

1. **Audit event** `PROVISIONAL_ACTION_STALE` (severity HIGH) — durable, one per stale action per tick window.
2. **Metric gauge** `provisional_action_stale_count` — the current count of stale actions, sampled by ops dashboards.

**Context.** Stale provisional actions indicate either an unusually long HCM outage or a reconciler failure. Both require operator attention; both have distinct audiences (HR/audit vs. ops).

**Alternatives considered.**

1. **Audit event only.** Pros: durable record. Cons: requires log greppping to surface; not actionable for ops in real-time.
2. **Metric only.** Pros: real-time dashboarding. Cons: sampled, not durable; lost when the metric pipeline has gaps; no record for HR post-incident.
3. **Both. (Selected.)** Pros: each audience gets the signal in the form they need. Cons: trivial duplication; both must be implemented correctly.
4. **Email/PagerDuty directly from the reconciler.** Pros: actionable. Cons: tightly couples the service to a specific notification mechanism; alerting is product/ops concern.

**Why selected.** Audit and metrics serve different purposes — the audit chain is forensic, the metrics are operational. Implementing both is cheap.

**Why a gauge and not a counter.** A counter accumulates and never decreases. A gauge reflects current state — when the reconciler drains stale actions, the gauge drops. Ops dashboards want the latter.

**Implications.**

- New audit event kind `PROVISIONAL_ACTION_STALE` in the audit taxonomy.
- Reconciler service injects a metrics adapter (no-op by default; production wires Prometheus or equivalent).
- `lastStaleAlertAt` timestamp on `ProvisionalAction` prevents flooding the audit log within a single tick (idempotency within tick window).
- Metric gauge name configurable for naming conventions per environment.
- Out-of-scope: the actual alerting integration (PagerDuty, Slack, email) is product/ops responsibility. Boundary defined in TRD §19.3.

**Test obligation.** Layer 21 covers: stale threshold not yet reached → no signal; threshold reached → audit event AND metric gauge populated; threshold reached but already alerted within window → no duplicate audit event (gauge still updated); reconciler drains the stale action → gauge drops to zero on next tick.

---

### ADR-026: HR Review Queue uses Relay-style cursor pagination (NEW in Rev 3.1, Q.μ)

**Decision.** The `hrReviewQueue` GraphQL query returns an `HrReviewItemConnection` with Relay-style `edges`, `pageInfo`, and `totalCount`. Forward pagination via `first` and `after`. Default page size 50, max 200.

**Context.** Revision 3 introduced the HR Review Queue as a flat list. For a fresh deployment, the list is small and a flat return is fine. For a customer with months of escalations, the list could grow to thousands of items — querying or rendering all of them in one request is wrong.

**Alternatives considered.**

1. **Flat list.** Pros: simplest. Cons: O(N) over the queue, with N unbounded.
2. **Offset pagination (`limit`/`offset`).** Pros: simple to implement. Cons: inconsistent under concurrent inserts (items can be skipped or duplicated as the underlying list changes). Cursor pagination doesn't have this issue.
3. **Cursor pagination (Relay-style). (Selected.)** Pros: consistent under concurrent inserts; matches existing GraphQL conventions; the rest of our query surface uses the same shape (planned).
4. **Streaming via subscription.** Pros: real-time updates. Cons: subscriptions are future work for this exercise; not justified by current use cases.

**Why selected.** Cursor pagination is the right default for any growing list. The Relay convention is widely understood and well-tooled.

**Implications.**

- New types `HrReviewItemConnection`, `HrReviewItemEdge`, `PageInfo`.
- Cursor is opaque (base64-encoded JSON `{flaggedAt, id}`); future cursor format changes don't break clients.
- Default page size 50 covers typical HR review batches; max 200 prevents accidental large requests.
- `totalCount` provided for UX (HR wants to know "how big is this backlog?"). Computed against the filter; potentially expensive on very large queues, but bounded by escalation volume.
- No `last`/`before` (reverse pagination). HR works front-to-back; reverse is future work if needed.

**Test obligation.** Layer 22 covers: empty queue → empty edges, pageInfo.hasNextPage=false, totalCount=0; full queue → first page with cursor; second page request → continues from cursor; new escalation arriving during pagination → visible on next refresh, doesn't disrupt cursor; max page size clamping; invalid cursor → error.

---

### ADR-027: EMPLOYEE_NOT_FOUND_AT_HCM during reconciliation — escalate to HR (NEW in Rev 3.1, Q.ν)

**Decision.** If the provisional reconciler's HCM query (history or call) returns `EMPLOYEE_NOT_FOUND`, the action transitions to `REJECTED_ESCALATED` with `hrReviewReason = "Employee no longer exists in HCM"`. A new `ReconciliationStepKind` value `EMPLOYEE_NOT_FOUND_AT_HCM` records the step. The request surfaces in the HR Review Queue.

**Context.** Edge case discovered during Rev 3 assembly: an employee's HCM record could be deleted (offboarding, data correction) between break-glass invocation and reconciliation. The `localStateSnapshot` has the employee's data; HCM no longer does. Pre-Rev 3.1, this branch was unhandled — the reconciler would have crashed or looped.

**Alternatives considered.**

1. **Crash the reconciler.** Pros: none. Cons: doesn't recover; blocks all subsequent reconciliations. Rejected.
2. **Skip the action, leave PENDING.** Pros: doesn't crash. Cons: action sits forever; stale-alert eventually fires but no resolution path. Rejected.
3. **Auto-resolve as NO_OP.** Pros: clean state. Cons: silently loses the audit chain for a case that's almost certainly an operational anomaly worth investigating. Rejected.
4. **Escalate to HR with explicit reason. (Selected.)** Pros: surfaces the anomaly to the team that can resolve it; preserves audit chain; maintains the "reconciler always reaches terminal state" invariant.

**Why selected.** This is exactly the case the HR Review Queue exists for: software cannot resolve it, but it should be surfaced clearly. The `localStateSnapshot` preserves what the employee's state was at break-glass time, which is enough for HR to determine the right manual action.

**Implications.**

- New `ReconciliationStepKind` enum value: `EMPLOYEE_NOT_FOUND_AT_HCM`.
- New error code: `EMPLOYEE_NOT_FOUND_AT_HCM_DURING_RECONCILIATION` (TRD §14.6).
- Branch in `ProvisionalReconciler.reconcileOne` handles `EMPLOYEE_NOT_FOUND` from both `queryTransactions` and `reserveBalance/releaseBalance` (HCM might return it from either).
- `MockHcmTestHarness` needs a helper to seed and then delete an employee mid-test (`deleteEmployee` admin method on the mock).
- Test obligation (TRD edge case 79): full flow covered in Layer 21.

**Audit chain.** From the request, walk to the `ProvisionalAction` (still has the full `localStateSnapshot` because the outcome is escalated — Q.θ retention). Walk to the `ReconciliationStep` with kind `EMPLOYEE_NOT_FOUND_AT_HCM`. The payload of that step includes the HCM error response and the timestamp. The audit event `PROVISIONAL_APPROVAL_ESCALATED` with subcategory `EMPLOYEE_DELETED` is the human-readable summary.

---

## Part II — Detailed Alternative Analysis

Extending TRD §20. Alternatives A-K covered in Revision 1; L-P added in Revision 2.

### Alternative L — Always fail closed during HCM outage (no break-glass)

**What it is.** During any HCM outage, all approvals return `HCM_UNAVAILABLE`. Managers wait for HCM to recover.

**Strengths.** Simplest. No new states, no new tables, no reconciliation pass. Guarantees HCM is always the arbiter at decision time.

**Weaknesses.** Operationally unacceptable for sustained outages. A two-hour HCM outage means no approvals for two hours. For a workforce-facing system, this affects payroll, scheduling, and employee experience. The brief itself emphasizes operational robustness.

**Why worse than selected.** The stakeholder explicitly rejected this. The break-glass mechanism preserves the spirit of "HCM is canonical" while accepting the operational reality.

### Alternative M — Always allow provisional approval (no role gate, no outage threshold)

**What it is.** Any approver can mark any request `PROVISIONALLY_APPROVED` whenever they want.

**Strengths.** Maximum availability. Trivial UX.

**Weaknesses.** Defeats the audit and accountability story. Over-approval becomes likely. The "HCM is dispositive" principle decays into "HCM is consulted when convenient."

**Why worse than selected.** Too permissive. Break-glass without governance is just a back door.

### Alternative N — Bootstrap only via batch

**What it is.** New employees become known only when the daily batch dump includes them.

**Strengths.** Simplest. One bootstrap path.

**Weaknesses.** New hires can't use the system for up to 24 hours. Unacceptable.

**Why worse than selected.** Latency.

### Alternative O — Bootstrap only via webhook

**What it is.** Rely solely on `EMPLOYEE_CREATED` webhooks.

**Strengths.** Fast, simple.

**Weaknesses.** Lossy. Network failures, our outages, HCM bugs all break this path. Worst case: an employee permanently unknown to us until daily batch.

**Why worse than selected.** No safety net.

### Alternative P — Native `number` for all units

**What it is.** Use JavaScript `number` for balances and units. Trust IEEE 754.

**Strengths.** Zero dependencies. Native math.

**Weaknesses.** `0.1 + 0.2 !== 0.3`. Repeated arithmetic compounds error. Comparisons fail. Half-day precision breaks. HCM agreement breaks.

**Why worse than selected.** Correctness.

### Alternative Q — Cancel during outage requires break-glass role

**What it is.** Provisional cancellation requires the same role gate as provisional approval.

**Strengths.** Symmetric. Maximally cautious.

**Weaknesses.** Cancellation is a credit operation: the downside of being wrong is bounded (HCM converges either way). Gating cancellation behind a role hurts UX for an operation that doesn't need it.

**Why worse than selected.** ADR-016 chose acknowledgment flag instead — preserves user agency while contracting the warning UX.

### Alternative R — Prevent PROVISIONALLY_APPROVED → TAKEN transition

**What it is.** Block the state transition until HCM reconciles.

**Strengths.** Prevents the awkward "TAKEN but unreconciled" terminal state.

**Weaknesses.** The leave happens in the real world regardless of what our state machine permits. Refusing to mark TAKEN is fiction — and one that confuses downstream consumers (reports, dashboards, payroll).

**Why worse than selected.** Honesty matters.

### Alternative S — Distinct TAKEN_UNRECONCILED state

**What it is.** Split TAKEN into two states: clean and unreconciled.

**Strengths.** Dashboards can filter trivially.

**Weaknesses.** More state-machine surface; every consumer that checks TAKEN must now also check the new variant. The `hrReviewFlag` accomplishes the same surfacing with less complexity.

**Why worse than selected.** Simpler design wins; future split is low-risk if needed.

### Alternative T — Provisional reconciler without pre-flight history query

**What it is.** Trust HCM's idempotency-key handling. Call reserveBalance with the action ID; rely on HCM to dedupe retries.

**Strengths.** Simpler reconciler logic. Fewer HCM calls in the happy path.

**Weaknesses.** Real HCM vendors vary in their key-honoring fidelity. If our reconciler crashes after calling HCM but before recording the outcome, we don't know whether HCM applied the call. The history query is the durable proof.

**Why worse than selected.** Exactly-once requires defense at multiple layers; one layer is insufficient.

### Alternative U — Strict append-only `ProvisionalAction` (no updates at all)

**What it is.** Store reconciliation outcomes as additional rows in a `ProvisionalActionReconciliation` table.

**Strengths.** Pure event-sourcing. Maximally auditable.

**Weaknesses.** Doubles the schema for the same information; reconciliation lookups need joins. The `ReconciliationStep` log already provides the lineage.

**Why worse than selected.** Over-engineered for our scope. Future migration is low-risk if compliance regulations require it.

### Alternative V — Reconciler issues both calls for pair-coalesceable actions

**What it is.** No pair-coalescing pass. Reconciler always issues every action's HCM call.

**Strengths.** Simpler reconciler.

**Weaknesses.** Doubles HCM call volume for a common scenario (approve-then-cancel during same outage). Doubles transaction history rows. Makes failure-mode reasoning harder (what if reserve succeeds but release fails?).

**Why worse than selected.** Pair-coalescing is both more efficient AND simpler in the failure case (no call to fail).

### Alternative W — Direct mock admin endpoint calls from each test

**What it is.** Tests call mock admin HTTP endpoints directly without a harness.

**Strengths.** No abstraction layer.

**Weaknesses.** Setup duplication, drift between tests, mock contract changes ripple through every test.

**Why worse than selected.** Centralization is engineering hygiene; the cost of the harness is negligible compared to the maintenance savings.

---

## Part III — Assumptions Made

Each assumption: stated, justified, flagged as confirmed by stakeholder, derived from spec, or assumed by Claude.

### Confirmed by stakeholder (Revisions 1 + 2 answers)

1. HCM is dispositive at every commit point that can reach HCM.
2. Manager-in-loop required for every approval.
3. `locationId` derived from `Employment.locationAt(startDate)`.
4. `LeaveTypeAvailability` modeled and tested.
5. Location transfers in scope.
6. Three-axis state model.
7. Single process, multi-module.
8. Polling outbox, not BullMQ.
9. HCM contract requires transaction confirmation.
10. Client-supplied idempotency keys required.
11. Canonical error taxonomy.
12. Configurable reconciliation cadences, tested as a concern.
13. HCM endpoints are cheap to call.
14. GraphQL because ReadyOn uses it in production.
15. **Break-glass override with provisional approval and event-driven reconciliation.** (NEW)
16. **Point-read jitter and coalescing.** (NEW)
17. **Canonical input serializer for idempotency.** (NEW)
18. **Mock HCM has its own SQLite for durable state.** (NEW)
19. **Employee bootstrap: webhook + lazy pull + batch (all three).** (NEW)
20. **`hcmVersion` is the ordering authority; `appliedAt` is informational.** (NEW)
21. **`decimal.js` for all unit arithmetic.** (NEW)
22. **Cancellation alert at threshold; provisional cancellation by default during outage.** (NEW)
23. **`policy.advanceLeaveToleranceUnits` is a UX hint, not enforcement.** (NEW)
24. **Mock HCM internal test layer added.** (NEW)

### Derived from spec

25. HCM provides realtime API.
26. HCM provides batch endpoint.
27. HCM may not always report errors.
28. Other systems may update HCM independently.
29. NestJS + SQLite stack.
30. Mock HCM as part of test suite.

### Assumed by Claude (please confirm or correct)

31. **All units are days, not hours.** Out of scope; flagged.
32. **Approval is single-step.** Out of scope; flagged.
33. **Cancellation of `TAKEN` requires manual HR.** Out of scope.
34. **Decimal precision per leave type, default 2 (half-day).** Configurable.
35. **All dates in location-tz, stored as `Date` (no time).**
36. **Self-approval rejected at boundary.**
37. **Mock does not compute accruals.** Scripted via admin endpoints.
38. **Outbox respects `Retry-After` headers; production has richer budgeting.**
39. **Single tenant per service instance.** Multi-tenancy via separate deployments.
40. **Authentication at upstream gateway; service trusts signed headers.**
41. **`hcmVersion` is monotonic and globally ordered per balance.**
42. **Idempotency-key TTL 7 days, configurable.**
43. **Audit log retention governed elsewhere.**
44. **Reconciliation does not roll back already-`TAKEN` leave.** Logged as `RETRO_CORRECTION`.
45. **Webhook signatures use HMAC-SHA256 with shared secret.**
46. **Inbox events processed in receive order per balance row; cross-row order irrelevant.**
47. **E2E tests use real HTTP to Mock HCM. Integration tests use in-process mock module.**
48. **System never queries HCM in a loop within a single request handler.**
49. **Break-glass minimum outage default 60s, configurable.**
50. **Break-glass requires explicit role; not granted to all managers by default.**
51. **`break_glass_approver` is a strict superset of regular approver permissions.**
52. **`HcmHealthMonitor` uses hysteresis: requires `healthRecoveryWindowMs` of consecutive successful checks before transitioning to REACHABLE.** Prevents flapping.
53. **Provisional cancellation requires no break-glass role.** Asymmetric with approval; lower risk.
54. **`PROVISIONALLY_APPROVED` requests where leave is taken before HCM confirms still attempt reconciliation; outcome may be `TAKEN` with `hrReviewFlag=true` (Rev 3) or `ESCALATED_TO_HR` if pre-leave-date.**
55. **HR escalation channel is boundary-defined.** Out-of-band notification mechanism (email, ticketing) is product-side. The data feed is `hrReviewQueue` (Rev 3).
56. **Mock HCM's SQLite is recreated per test fixture for determinism.**
57. **Mock HCM's test layer (Layer 17) catches mock bugs that would otherwise produce false confidence.** New testing-of-tests pattern.
58. **`Decimal` flows through GraphQL as string scalar; never as JSON number.**

### Rev 3 additions

59. **Cancellation-during-outage requires `acknowledgedHcmUnavailable: true` field.** Trust boundary with the UI: server records the flag in audit; UI is expected to render the warning. UI bugs that set the flag without rendering are auditable but not preventable server-side.
60. **`PROVISIONALLY_APPROVED → TAKEN` is allowed with `hrReviewFlag`.** The leave happens in the real world; our state machine reflects that.
61. **`TAKEN` is no longer strictly "happy terminal".** Dashboards must check `hrReviewFlag`. Documented loudly.
62. **HR Review Queue surfaces three categories.** Pre-leave escalations, post-leave HR-flag, stuck cancellations. New `hrReviewQueue` query.
63. **HCM contract MUST support `queryTransactions` with idempotency-key filter.** Real adapters that can't synthesize this are flagged as "best-effort exactly-once."
64. **Provisional reconciler issues pre-flight history query before every reserve/release.** This is the layer that protects against double-application across our restarts.
65. **Every reconciler step is recorded in `ReconciliationStep` (append-only).** The log is the source of truth for "where to resume" after a crash.
66. **`ReconciliationStep` is strictly append-only; no updates ever.**
67. **`ProvisionalAction` allows updates only on three reconciliation fields.** Repository enforces; SQLite trigger optional.
68. **Pair-coalescing applies only to opposing actions on the same request.** State machine prevents other chains.
69. **Coalesced actions are NOT deleted; both persist with `NO_OP`.** Audit chain intact.
70. **`MockHcmTestHarness` is the only way tests interact with the mock.** Ad-hoc admin HTTP calls in tests are a smell.
71. **The harness has its own unit tests.** Without them, harness bugs masquerade as system bugs.
72. **`ProvisionalAction.id` is the idempotency key used at HCM during provisional reconciliation.** Stable across our restarts and HCM retries.

### Rev 3.1 additions

73. **`ProvisionalAction.localStateSnapshot` is retained in full only for ESCALATED outcomes.** Summarized to ~200 bytes on CONFIRMED/NO_OP. Configurable via `reconciler.snapshotRetention.summarizeAfterSuccess`.
74. **`ProvisionalAction` allow-list grows to five fields in Rev 3.1.** `markReconciled` may update `reconciliationState`, `reconciledAt`, `reconciliationDetails`, `localStateSnapshot` (only to null on success), `localStateSnapshotSummary` (only on terminal).
75. **`ReconcilerLease` table is a single row with TTL.** Crashed workers don't block reconciliation for long; subsequent ticks reclaim the lease after `expiresAt`.
76. **`reconciler.leaseTtlMs` default 60 seconds.** Anything longer is anomalous.
77. **Pre-flight history-query window default 24 hours.** Wide enough to cover any plausible reconciler delay; narrow enough to bound query work.
78. **Transactions outside the window are not seen by the reconciler.** Defensive layer is HCM's own idempotency-key handling plus daily batch reconciliation.
79. **Stale-provisional-action signals are dual: audit event AND metric gauge.** Audit for HR/forensic; metric for ops/dashboards.
80. **Employee deletion at HCM during a pending provisional action results in `REJECTED_ESCALATED`.** Software cannot fix this; HR Review Queue surfaces it. Full `localStateSnapshot` retained (matches ADR-022 escalation case).

---

## Part IV — Tradeoff Summary

The system optimizes, in priority order:

1. **Correctness with respect to HCM.** Above all else.
2. **Defensive behavior against HCM bugs.** Layered, redundant.
3. **Operational continuity during sustained HCM outage.** Via break-glass + event-driven reconciliation.
4. **Simplicity of operational deployment.** Single process, no Redis.
5. **Test determinism.** Polling, controlled mock, deterministic property generators.
6. **Testability of every guarantee.** The test plan is the contract.
7. **UX latency on common paths.** Local projection for reads; HCM call at decision points.
8. **Future scalability.** Clean migration paths to Postgres, multi-process workers, real adapters.

We accept the following costs:

- **Approval latency depends on HCM when reachable.** Mitigated by cheap calls.
- **Polling adds up to 1s dispatch latency.** Configurable.
- **Local projection can lag.** Tolerable; HCM is dispositive when reachable.
- **More state types than minimum.** Tradeoff for testability and clear concerns.
- **Break-glass adds complexity.** Mitigated by clear event-sourced design and audit trail.
- **Three bootstrap paths add code.** Mitigated by encapsulation in `EmployeeBootstrapService`.
- **Canonicalization adds CPU cost on every mutation.** Negligible; correctness paramount.
- **(Rev 3) Provisional reconciler adds two HCM calls per provisional action** (history query + actual call). Acceptable: HCM calls are cheap per stakeholder; exactly-once is worth it.
- **(Rev 3) ReconciliationStep log grows over time.** Archival policy is operational; data retention is bounded by event-log retention policy.
- **(Rev 3) `TAKEN` is no longer strictly happy terminal.** Documented loudly; dashboards must check `hrReviewFlag`.
- **(Rev 3.1) Snapshot summarization on success adds a small write path.** Negligible runtime cost; one more allow-listed field on `markReconciled`. Storage savings far outweigh.
- **(Rev 3.1) ReconcilerLease introduces a new table.** Tiny — one row total. The debuggability and crash-safety properties more than justify it.
- **(Rev 3.1) HR Review Queue pagination adds GraphQL types** (`Connection`, `Edge`, `PageInfo`). Standard pattern; future work for other queries already heading this way.
- **(Rev 3.1) Metric gauge for stale actions** requires a metrics adapter. No-op default; production wiring is configuration. Negligible cost.

The break-glass complexity (Rev 2) and the provisional-reconciler formalization (Rev 3) are the largest new costs and are paid willingly. Rev 2 converted an operational liability into a managed risk. Rev 3 made the reconciliation auditable and exactly-once. Rev 3.1 cleaned up the operational fabric — storage bounds, lock primitives, alerting integration, pagination, edge-case handling — without changing the underlying architecture. Together they form a defensible end-to-end story: from the moment of break-glass invocation to the moment of HCM confirmation, every step is recorded, replayable, and provably executed at most once.
