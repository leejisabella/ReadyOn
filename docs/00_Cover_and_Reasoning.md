# Cover & Design Reasoning

**Status:** Revision 3.1
**Reads first.** Synthesizes the four-document set into a narrative of design choices, reasoning, and tradeoffs.
**Companions:** `01_TRD.md`, `02_Assumptions_and_Decisions.md`, `03_Test_Plan.md`, `04_Module_Plan.md`

---

## CHANGELOG (since Revision 3 cover)

Rev 3.1 closes six open questions surfaced during Rev 3 review. The architectural narrative is unchanged; the operational fabric tightens.

- **§4 (UPDATED):** Two new subsections — snapshot retention policy and the ReconcilerLease primitive — document the Rev 3.1 additions.
- **§6 (UPDATED):** "What I would re-examine" — most prior open items are now resolved or have explicit configuration knobs.
- **§11 (UPDATED):** Risks list reflects Rev 3.1 mitigations and the small new risks Rev 3.1 itself introduces.

---

## CHANGELOG (since Revision 2 cover)

- **§3 (UPDATED):** The "architectural inversion" narrative now includes Rev 3's exactly-once formalization as the third decisive shift.
- **§4 (UPDATED):** New subsections describe the `ReconciliationStep` log, the HR Review Queue, the pair-coalescing logic, the cancellation acknowledgment contract, and the harness.
- **§5 (UPDATED):** Trade-off table extended with five Rev 3 entries.
- **§6 (UPDATED):** "What I would re-examine" reflects what got *resolved* in Rev 3 and what remains genuinely open.
- **§7 (UPDATED):** Test composition narrative includes the five new test layers.
- **§8 (UPDATED):** Implementation order revised — Rev 3 layers slot in around their producers.
- **§11 (UPDATED):** Risk list reflects Rev 3 mitigations and the new risks the additions themselves carry.
- **§12 (NEW, Q.η):** SQLite-to-Postgres migration shape.

---

## 0. Why this document exists separately

The TRD answers *what*. The Assumptions doc answers *why this and not that*. The Test Plan answers *how we know it works*. The Module Plan answers *where in code does it live*. This document answers the question that sits above all four: *if I had to defend every decision in this design under questioning, what would I say?*

It is written as a narrative so the reasoning is legible end-to-end rather than scattered across reference sections. It is the last document I would delete and the first I would write again.

---

## 1. What problem we are actually solving

The brief asks for a time-off microservice. That's the surface. The actual problem is harder:

We are building a system that owns a workflow (time-off requests) but does not own the data the workflow is *about* (balances, employment, leave-type validity). The data lives in HCM. The workflow lives here. The two must agree, but the brief warns explicitly that HCM does not always tell the truth about whether it has agreed.

So the real problem is: **how do we run a stateful business workflow on top of a partially-unreliable external source of truth, in a way that is honest about the gaps, auditable when they bite, and operationally continuous when the dependency disappears?**

Every decision in the four documents flows from this framing. The choices that look like over-engineering in isolation are exactly the choices required by the problem as stated.

---

## 2. The three principles, restated

The design rests on three principles. These appear in `01_TRD.md §1` as a list; the reason they belong at the top of every design conversation is worth spelling out.

### 2.1 HCM is dispositive when reachable

When we can talk to HCM, HCM decides. We don't pretend to know better. We don't approve requests HCM would reject. We don't reject requests HCM would accept. The local projection serves the UI and accelerates reconciliation; it does not arbitrate.

This principle is what makes most of the system simple. We do not need pessimistic locking on balance rows because HCM's own concurrency model handles it. We do not need to model every edge of HCM's accrual logic because we ask HCM directly at decision time.

### 2.2 Defensive against silent failure

HCM may succeed and report failure. HCM may fail and report success. HCM may do neither and report both. Whenever HCM responds, we validate not just the shape but the *meaning*: did the operation we requested actually happen? This is where the `deltaApplied` requirement in the HCM contract earns its keep. Without it, the verification reduces to balance arithmetic, and arithmetic is unsound the moment another process touches the balance concurrently.

Behind the contract is a defense-in-depth: pre-validation, response validation, transaction confirmation cross-check, deferred point-read, periodic drift sweep, and daily batch reconciliation. For any drift to persist past 24 hours, all six must fail at once.

### 2.3 Operationally continuous when HCM is unreachable

This is the principle Revision 2 added explicitly. Revision 1 was honest about the operational cost of fail-closed but did not solve it. Revision 2 solves it through the break-glass mechanism: explicit, role-gated, time-gated, event-logged provisional approvals that reconcile back to HCM truth when HCM returns. The system never lies to itself about what HCM said — when HCM has not said anything, we mark the decision as provisional and own the reconciliation obligation in writing.

The same principle applies to cancellations during an outage: they proceed provisionally (without a role gate, because they're credit operations with bounded risk) and reconcile back to HCM truth on recovery.

---

## 3. The architectural shifts that define Revisions 2 and 3

### 3.1 Revision 2's shift: from local-arbiter to HCM-arbiter

The single biggest shift between Revision 1 and Revision 2 was the recognition that the local state is no longer the arbiter of truth even temporarily. In Revision 1, holds prevented overdraft. In Revision 2, HCM prevents overdraft; holds are accounting projections that inform the UI and enable reconciliation. This sounds like a small reframing. It changed the system substantively:

- **Concurrency.** Two concurrent approvals do not need to be serialized locally. HCM serializes them. We learn the outcome by reading HCM's response.
- **Idempotency.** Client keys protect against double-submission, but they don't have to prevent over-debit at the local layer. Over-debit is HCM's concern.
- **Validation order.** Pre-validation became advisory. We don't reject based on local state alone except for clear input errors (bad dates, unknown leave type at a location). For balance sufficiency, HCM decides.
- **State machine.** `AWAITING_HCM_COMMIT` is a meaningful state because the local commit precedes the canonical commit. `PROVISIONALLY_APPROVED` is meaningful because *the canonical commit may never have happened*.
- **Reconciliation.** Provisional reconciliation became a first-class concern, not a maintenance task.

This inversion was the right shape for a system where the dependency is canonical.

### 3.2 Revision 3's shift: from "we reconcile" to "we prove we reconciled exactly once"

Revision 2 said the provisional reconciler exists; Revision 3 says how. The formalization is the largest design step in Revision 3 and the one that earns the strongest correctness claim:

- Every reconciliation step is recorded as a `ReconciliationStep` row before any HCM call.
- Before any HCM mutation, we query HCM's transaction history for a matching idempotency key.
- The combination of (a) our step log, (b) HCM's idempotency-key honoring, and (c) our pre-flight history query stack three independent guarantees of exactly-once execution at the system boundary.

The claim this lets us defend: *every provisional action causes exactly one HCM debit or credit, and the audit log proves it from rows alone.* That's a strong claim, and it's the claim a workforce-of-record system needs to make.

### 3.3 The three principles, restated against both shifts

The three principles from §2 hold across both shifts:

1. **HCM is dispositive when reachable** — Revision 1 idea, Revision 2 made it strict.
2. **Defensive against silent failure** — Revision 1 idea, Revision 3 closed the last gap (reconciler exactly-once).
3. **Operationally continuous when HCM is unreachable** — Revision 2 idea (break-glass), Revision 3 made it provably correct (audit log lineage).

---

## 4. Why each major piece exists

### 4.1 The three hold buckets

Three buckets — `pendingHold`, `approvedHold`, `provisionalHold` — exist because they have *different decision-time semantics*:

- `pendingHold` is purely UX projection. It tells the employee "you've requested this much." It has no HCM counterpart. If we lose it, no decisions break.
- `approvedHold` is the brief in-flight window between our local approval and HCM's confirmation. It's measured in milliseconds in normal operation. It exists primarily so a crash during that window doesn't lose the fact that we asked HCM to debit.
- `provisionalHold` is the durable accounting of break-glass approvals. It's measured in minutes, hours, or potentially days. It is the part of the local state that *might* not match HCM, and reconciliation is the process that resolves it.

A single bucket would conflate operational realities that need to be reasoned about separately. The accountant in `BalanceModule` knows the difference, and the test matrix exercises each kind in isolation.

### 4.2 The provisional action event log

`ProvisionalAction` is event-sourced because the decisions it records are exactly the decisions we may need to defend later. If a manager invokes break-glass and the leave is later denied by HCM, the question "why did we approve this?" must be answerable from the row, with full local-state snapshot at the moment of invocation, the actor, the justification, the duration of the HCM outage at that moment, and the reconciliation outcome.

This is event-driven architecture at the boundary where it matters most: the boundary between decisions made without HCM and decisions confirmed by HCM. The rest of the system can be CRUD; this part cannot.

### 4.3 The HCM health monitor

We could have written "if `hcmAdapter.call()` throws, fail closed." We didn't, because that confuses a single transient error with a sustained outage. The break-glass mechanism only makes sense once we have established that HCM has been unreachable for a meaningful period. The health monitor with hysteresis (consecutive failures to declare UNHEALTHY, consecutive successes within a window to declare HEALTHY again) is what separates "blip" from "outage." Without it, break-glass would either be unavailable when needed (no signal) or available too often (flaps on transient errors).

### 4.4 The employee bootstrap service

A user-facing system that returns "unknown employee" when a new hire tries to use it has failed at its first job. The bootstrap service exists because we cannot rely on any single delivery mechanism for new-employee data:

- Webhook is fast and right when it works, but webhooks get lost.
- Lazy pull is correct on demand but requires HCM to be reachable.
- Batch is unconditional but daily.

Three together, all idempotent on the `Employee` row, mean the answer to "why is this employee not in our system?" is almost always "they will be in seconds," not "they will be in 24 hours."

### 4.5 The canonical input serializer

Idempotency without canonicalization is theatre. Two clients submitting "the same" request can produce different hashes if one of them uses `2025-01-15T00:00:00Z` and the other uses `2025-01-15`. The serializer pins exactly one canonical form (typed parse → reserialize with sorted keys, NFC strings, ISO dates, Decimal-precision-correct numerics) so the system's idempotency contract is well-defined.

This is the kind of detail that doesn't matter for a demo and matters acutely in production. We chose to specify it now.

### 4.6 The mock HCM with its own SQLite

The mock isn't a stub; it's an integration partner. Treating it like a remote system — separate process, separate database, durable state, admin endpoints to drive its state, adversarial modes to misbehave deliberately — is how we get tests that mean what they say. Crash-recovery tests in particular are only meaningful if "did HCM apply the change?" has an answer that survives the service's crash. SQLite gives us that.

### 4.7 The ReconciliationStep log (Rev 3, Q.γ)

This table exists because the provisional reconciler is the keystone of the audit story, and "trust me, I reconciled" is not an audit story. Every step the reconciler takes — history query, in-flight call, outcome applied, pair-coalesced — produces a row before the reconciler proceeds. On restart, the reconciler reads its own step log to determine where to resume. The combination of step log + idempotency key + HCM history query gives exactly-once execution as a property verifiable from the database alone.

The step log is strictly append-only. No row is ever updated; no row is ever deleted. The reconciler is a stateless consumer of its own log. This is purest event-driven architecture and it's load-bearing: if the log could be rewritten, the audit chain would be unreliable, and the strongest claim the system makes would be unverified.

### 4.8 The HR Review Queue (Rev 3, Q.β)

`TAKEN` is no longer strictly "happy terminal." A provisional approval whose reconciliation eventually fails after the leave has been taken transitions to `TAKEN` with `hrReviewFlag = true`. This is the right shape (the leave happened) but it means dashboards must check the flag. The HR Review Queue surfaces these and two related categories (pre-leave escalations, stuck cancellations) through a single GraphQL query gated to the `hr_admin` role.

This is a small piece of code with a large operational footprint: it's the data feed for the HR team's tool to resolve the cases software can't fix on its own.

### 4.9 The pair-coalescing pass (Rev 3, Q.ζ)

If an employee is approved provisionally and then cancels during the same outage, the naïve reconciler would call HCM twice — reserve, then release — for what is net zero. Worse, if either call fails mid-pair, the partial state is hard to reason about. Pair-coalescing recognizes opposing actions at the start of the reconciler pass and resolves both as `NO_OP` without HCM calls. Both `ProvisionalAction` rows persist with `NO_OP` state; a `PROVISIONAL_PAIR_COALESCED` audit event ties them with explicit rationale.

This is an optimization that pays for itself in correctness: zero HCM calls means zero partial failures.

### 4.10 The cancellation acknowledgment contract (Rev 3, Q.α)

Cancellation during HCM outage requires `acknowledgedHcmUnavailable: true` in the input. The server cannot verify the UI rendered the warning; it can only require the flag and audit who set it. This is a UI-server trust boundary, documented as such. We trade a perfect contract for a workable one — the audit chain establishes "the caller asserted acknowledgment," and any UI that sets the flag without rendering is a UI bug auditable from logs.

This is the kind of design where the right answer is to be honest about what we can and can't enforce, and ensure the audit trail makes the assumption recoverable.

### 4.11 The MockHcmTestHarness (Rev 3, Q.ε)

The Mock HCM has many degrees of freedom. Without centralization, every test re-implements setup boilerplate, drift creeps in, and mock-contract changes ripple through every test file. The harness gives every test a single, typed, documented entry point. It's testing infrastructure, not production code, but it's load-bearing in a different way: a broken harness silently invalidates every test that depends on the mock. So the harness has its own self-tests (Layer 24), and the convention is enforced by review.

### 4.12 The snapshot retention policy (Rev 3.1, Q.θ)

`ProvisionalAction.localStateSnapshot` is the full balance/request/employment/leave-type state captured at break-glass invocation. It exists for one purpose: when reconciliation fails and HR has to investigate, they need to see what the system thought at the moment of the decision. That's the entire forensic story.

The retention policy matches the access pattern. CONFIRMED and NO_OP outcomes will never be investigated — nobody reads the snapshot for cases that worked. ESCALATED outcomes are exactly where the snapshot earns its storage. So: full snapshot on insert, summarize on success, retain on escalation. The summary is small (~200 bytes) and preserves structural decision data (balance hash, request IDs, actor) so the audit chain remains complete; the full snapshot is the deep forensic artifact reserved for the cases that need it.

This is the kind of policy that costs nothing for the common case and is worth a lot when it pays off — exactly the right trade for forensic data.

### 4.13 The ReconcilerLease primitive (Rev 3.1, Q.ι)

The reconciler must not run concurrently with itself — the pre-flight history query plus call sequence isn't safe under concurrency. We need a lock. A row-based lease with TTL was chosen over `BEGIN EXCLUSIVE` for one reason that matters more than I initially thought: debuggability. When something goes wrong, an operator can `SELECT * FROM reconciler_lease` and see who's holding the lock, when they acquired it, when it expires. With `BEGIN EXCLUSIVE`, this information is implicit in the database engine's lock manager and impossible to query in production.

The TTL handles the crash case. If a worker crashes mid-tick, the lease becomes stealable after `leaseTtlMs` passes. No human intervention needed; the next tick just succeeds. The Postgres migration story is clean: replace the row-based lease with `pg_advisory_lock` and the rest of the application code stays the same shape. The interface (`tryAcquire`, `release`, `inspect`) survives both engines.

### 4.14 The HR Review Queue pagination (Rev 3.1, Q.μ)

The queue was a flat list in Rev 3. Rev 3.1 adds Relay-style cursor pagination — `first`, `after`, `edges`, `pageInfo`, `totalCount`. This is the right default for any growing list in a GraphQL surface, and it should set the convention for other queries that eventually need pagination too.

The choice of cursor over offset was deliberate. Offset pagination has the well-known consistency problem: items can be skipped or duplicated as the underlying list changes during pagination. Cursor pagination doesn't have that issue because the cursor encodes the position in the ordering, not the index. For a queue that receives new items in real time (escalations arrive as the reconciler runs), cursor consistency is the difference between "I'm sure I saw every item" and "I might have missed something during the page boundary."

---

## 5. The choices we made deliberately, and what we lost

Every design choice gives something up. Naming the losses is part of taking the choices seriously.

| Choice | What we lost |
|---|---|
| HCM dispositive | Approval latency depends on HCM. If HCM is slow, approvals are slow. Mitigated by cheap calls; degraded by break-glass during outage. |
| Polling outbox | Up to 1 second average dispatch latency to HCM. Acceptable for human workflows. |
| Single process | Cannot scale horizontally on this design. Migration to Postgres + multi-process is future work (§12). |
| Three hold buckets | More states to reason about; more tests; more rows. The clarity benefit outweighs the cost. |
| Break-glass mechanism | Real operational complexity: a new role, a new mutation, a new state, a new table, a new reconciler. The cost is paid willingly; an outage that blocks all approvals for hours is worse. |
| Required HCM contract | We can't use HCM vendors that won't return `deltaApplied`. Real adapters must synthesize it via follow-up reads if their vendor doesn't expose it. Rev 3: the contract also requires `queryTransactions` for exactly-once. |
| SQLite | No concurrent writers. Single-process becomes mandatory, not just preferred. |
| `decimal.js` | A library dependency; some serialization fiddliness. Worth it for arithmetic correctness. |
| GraphQL | Slightly more ceremony than REST for mutation-heavy workflows. Counterbalanced by ReadyOn's existing GraphQL stack. |
| Event-sourced provisional actions | A table that grows over time and a reconciler that must drain it correctly. The audit trail is worth the complexity. |
| Strict idempotency canonicalization | Engineering effort on a detail clients don't see. The class of bugs it prevents is real and would be expensive in production. |
| **(Rev 3) Pre-flight HCM history query before every reconciliation call** | Two HCM calls per provisional action instead of one. Acceptable: HCM calls are cheap, exactly-once guarantee is worth it. |
| **(Rev 3) ReconciliationStep log** | Another table, append-only growth, archival operational concern. Worth it for verifiable exactly-once. |
| **(Rev 3) Pair-coalescing logic** | More code paths in the reconciler. Worth it: fewer HCM calls and simpler failure modes. |
| **(Rev 3) Cancellation acknowledgment flag** | Mutation surface gets one more required field during outage. The audit clarity is worth it. |
| **(Rev 3) MockHcmTestHarness** | Another piece of test code to write and maintain. Worth it: every test layer gets cleaner setup; mock contract changes update one file. |
| **(Rev 3) `TAKEN` is no longer strictly happy terminal** | Dashboards must check `hrReviewFlag`. Documented loudly. |

We did not take the easy path on any of these. Each was chosen with eyes open.

---

## 6. What I would re-examine if I could

If I were doing this again with one more week, I would dig deeper into:

1. **The cost of `decimal.js` at scale.** For our throughput, it's negligible. For a system with millions of decimal operations per second, the cost is not. Worth measuring.
2. **The exact backoff schedule for the outbox worker.** I specified exponential with jitter, but the choice of base, ceiling, and maximum attempts came from instinct, not analysis. Production tuning required.
3. **The break-glass role model.** A single `break_glass_approver` role may be too coarse. A bigger system would want per-department, per-leave-type, or per-employee-tier authorization.
4. **~~The provisional reconciliation's escalation policy.~~** *Resolved in Rev 3:* `ESCALATED_TO_HR` and `TAKEN+hrReviewFlag` both surface via `hrReviewQueue`. The HR-facing UI tool is still out of scope (boundary), but the data feed is now well-defined.
5. **~~The interaction between provisional actions and post-approval cancellation.~~** *Resolved in Rev 3:* pair-coalescing handles this explicitly (Q.ζ). Layer 23 covers all four orderings.
6. **The `Employee` table's relationship to multi-tenancy.** Today's single-tenant assumption keeps it simple; production needs a tenant scope.
7. **~~Whether to expose `provisionalActions` in the public GraphQL or behind an internal-only auth boundary.~~** *Resolved in Rev 3:* the `hrReviewQueue` query is the right HR-facing surface, role-gated. Raw `provisionalActions` query remains internal.
8. **~~The `provisionalActionStaleAlertMs` default.~~** *Partially resolved in Rev 3.1, Q.λ:* now emits both audit event and metric gauge, so operators can dashboard and alert. The default of 4h is intuition, not analysis — should be tuned per customer.
9. **~~The advisory-lock primitive choice.~~** *Resolved in Rev 3.1, Q.ι:* row-based `ReconcilerLease` table for debuggability; Postgres migration replaces with `pg_advisory_lock`.
10. **~~`ProvisionalAction.localStateSnapshot` retention.~~** *Resolved in Rev 3.1, Q.θ:* summarize on success, retain on escalation; configurable.
11. **~~Pre-flight history-query window.~~** *Resolved in Rev 3.1, Q.κ:* 24h default, configurable; covered by Layer 7 daily reconciliation as backstop.
12. **~~HR Review Queue pagination.~~** *Resolved in Rev 3.1, Q.μ:* Relay-style cursor pagination; consistent across the GraphQL surface.
13. **~~Employee deletion at HCM during a pending provisional action.~~** *Resolved in Rev 3.1, Q.ν:* new `ReconciliationStepKind.EMPLOYEE_NOT_FOUND_AT_HCM`; escalates to HR with explicit reason.

**Still genuinely open:**

- **Backoff tuning** (item 2) — depends on customer load patterns.
- **Multi-tenancy** (item 6) — major future work; out of scope for this exercise.
- **Graduated break-glass authorization** (item 3) — depends on organizational structure.
- **Snapshot archival to cold storage** — Rev 3.1 bounds the live storage growth via summarization, but full-snapshot escalations still grow over time. Archival is operational.
- **Real-vendor `queryTransactions` semantics** — depends on the vendor; the adapter contract is well-defined, but real vendors will require adapter-specific synthesis.

These are not gaps in the design as stated; they are places where the design as stated is correct but the surrounding operational fabric is thin.

---

## 7. What the test suite is actually checking

The test suite is described in detail in `03_Test_Plan.md`. The thing worth saying separately is that each layer is there to defeat a specific class of regression:

- **Unit:** logic regressions (arithmetic, state-machine rules, validators).
- **Integration:** seam regressions (wiring, transactions, GraphQL formatting).
- **End-to-end:** integration drift between processes (HTTP semantics, real serialization).
- **Property-based:** concurrency and edge cases that example tests systematically miss.
- **Failure injection (outbound):** defensive behavior rots silently otherwise.
- **Inbound adversarial:** the system's other boundary surface, symmetric to outbound.
- **Reconciliation:** the safety net we rely on to converge everything else.
- **Contract:** the HCM port shape, pinned. Changes must be deliberate.
- **Mutation:** the test suite's own integrity. Catches tests that don't assert.
- **Configuration:** unwired config values silently degrade behavior.
- **State machine:** illegal transitions become possible without coverage.
- **Error taxonomy:** error codes drift from documentation.
- **Location transfers:** the largest mechanical surface; bugs here are user-visible.
- **LeaveTypeAvailability:** dimension validity is silent until it fails.
- **Idempotency:** double-debit is catastrophic.
- **Crash recovery:** workers that don't recover, double-charge.
- **Mock HCM internal:** if the adversary is buggy, every test above it is meaningless.
- **Break-glass:** the most consequential new flow in Revision 2; under-testing here means provisional approvals could be issued incorrectly or reconciled incorrectly.
- **Bootstrap:** the path a new hire takes; if it has a hole, new hires can't use the system.
- **(Rev 3) Provisional reconciler exactly-once:** the keystone claim. Without it, the strongest correctness statement is unverified.
- **(Rev 3) HR review queue:** the data feed for the team that resolves what software can't. Bugs surface as missed irregularities (silent) or false alarms (loud) — both expensive.
- **(Rev 3) Pair-coalescing:** an optimization that's load-bearing for correctness in opposing-action scenarios.
- **(Rev 3) MockHcmTestHarness self-tests:** test infrastructure correctness; bugs here invalidate everything above.
- **(Rev 3) Cancellation acknowledgment contract:** the UI-server boundary for warning rendering. Drift here is silent and expensive.

Removing any one layer creates a specific blind spot. The composition is designed so each class of regression has exactly one set of tests responsible for catching it, and no class is uncovered.

---

## 8. What an agentic developer should do first

Given the five-document set, the implementation order I would recommend:

1. **Scaffold the monorepo.** Both apps, both `tsconfig.json`s, both `package.json`s, common libraries. Run a `npm test` that finds zero tests and exits 0.
2. **Implement the `Decimal` scalar, the `CanonicalInputSerializer`, the `ErrorCode` enum.** These are foundational; getting them wrong infects everything else. Write their unit tests first.
3. **Implement the HCM port interface and zod schemas, including `queryTransactions`.** No adapters yet. Just the shape.
4. **Implement the Mock HCM with its own SQLite, normal mode only.** Includes `queryTransactions` natively. No adversarial modes yet.
5. **Implement the `MockHcmTestHarness`.** With its self-tests (Layer 24). Every higher test layer will depend on it.
6. **Implement the database schema and migrations.** All tables, all indexes. Includes `ProvisionalAction` and `ReconciliationStep` (with append-only repository conventions). Optional trigger migration as a separate file.
7. **Implement the Mock HCM adapter and the HCM health monitor.** Wire them. Adversarial modes come next.
8. **Implement domain modules one at a time:** Employment → LeaveTypeAvailability → EmployeeBootstrap → Balance → Request. Unit and integration tests at each step.
9. **Implement the outbox, inbox, and outbox worker.** End-to-end happy path test goes green here.
10. **Implement the reconciliation module's three normal cadences** (point-read, drift, batch). Property-based tests on invariants go green.
11. **Implement break-glass: `ProvisionalAction`, `BreakGlassAuthorizer`.** API mutation goes green; break-glass-without-reconciliation tests (Layer 18) green.
12. **Implement `ReconciliationStepModule` + `ProvisionalReconciler`** with the formalized algorithm. Pre-flight history query, step log, advisory lock, pair-coalescing. **Layer 21 + Layer 23 go green here.**
13. **Implement `HrReviewModule`.** Layer 22 goes green.
14. **Add cancellation acknowledgment contract.** Layer 25 goes green.
15. **Add adversarial modes to Mock HCM.** Failure-injection tests (Layer 5) go green.
16. **Add inbound adversarial scenarios** (Layer 6). Webhook signature, replay, flood tests go green.
17. **Add crash-recovery tests** (Layer 16). Mock's durable SQLite plus the harness make them meaningful.
18. **Wire up mutation testing on critical modules.** Iterate until kill rate clears the gate.

Each step ends with tests green; no step bundles work that crosses a feature boundary. The Rev 3 layers (21–25) cluster around step 12 because the formalized reconciler is the keystone — everything else has been waiting for it.

---

## 9. Where the design intentionally does not go

The brief's note that "tests are more important than code" is taken seriously. The design intentionally avoids the temptation to over-engineer in directions that produce more code without more confidence:

- **No event-bus library.** In-process domain events are simple subscriptions, not Kafka.
- **No CQRS.** Read paths use the same models as write paths; projections are tables, not separate stores.
- **No event sourcing for the whole domain.** The audit log is sufficient for the whole domain; event sourcing is reserved for the provisional-action boundary and the reconciliation-step log, where it pulls its weight.
- **No abstract repository pattern with generic CRUD.** Each repository is concrete and has only the methods the domain needs. Append-only repositories (Rev 3) take this further: only `insert` and one allow-listed update method on `ProvisionalAction`; only `insert` on `ReconciliationStep`.
- **No GraphQL subscriptions for this exercise.** Mentioned in future work; not implemented.
- **No micro-services.** One service, one mock. The exercise asks for a microservice; "micro" here means one bounded context.
- **(Rev 3) No strict-append-only via separate reconciliation table.** Repository convention + optional trigger is sufficient. Strict append-only with a separate `ProvisionalActionReconciliation` table is documented as future work for compliance contexts only.

Each of these is a place where standard "enterprise" thinking would add complexity. We pass.

---

## 10. The shape of the deliverable, restated

Five documents, in order of importance:

1. **`01_TRD.md`** — the specification. Every guarantee, every state, every endpoint.
2. **`03_Test_Plan.md`** — the contract. If a guarantee in the TRD doesn't appear in the test plan, it's aspirational.
3. **`02_Assumptions_and_Decisions.md`** — the defense. Every decision with the alternatives I rejected and why.
4. **`04_Module_Plan.md`** — the implementation guide. Where the design lives in code.
5. **`00_Cover_and_Reasoning.md`** — this document. The narrative.

Future revisions should update all five. The documents reference each other by section; broken links are bugs.

---

## 11. Risks remaining

Revisions 2, 3, and 3.1 each closed some prior risks and introduced new ones. The full status, with Rev 3.1 marking what's now mitigated:

### 11.1 Rev 2 risks (status reviewed in Rev 3 and Rev 3.1)

1. **The `policy.advanceLeaveToleranceUnits` is UX-only.** Status: unchanged. The docs are explicit; the surprise is still possible for a reviewer who skims.
2. **~~`ESCALATED_TO_HR` requests may never get resolved.~~** Status: closed for the data feed (Rev 3 added `hrReviewQueue`). The resolution UI is still operational/product responsibility.
3. **The break-glass role is binary.** Status: unchanged. Future work (TRD §21) lists graduated authority as an item.
4. **The mock HCM's adversarial modes are not exhaustive.** Status: unchanged. Production-bound work would add fuzz testing.
5. **The bootstrap path is robust but not free.** Status: unchanged. Layer 19 covers the race conditions.
6. **Crash recovery during the brief `approvedHold` window** is correct but tested less exhaustively than longer-lived states. Status: narrower — Rev 3 added explicit step-level crash-recovery tests for the reconciler (Layer 21 T-PR-EX-05/-06/-07), but `approvedHold` itself wasn't touched.

### 11.2 Rev 3 risks (status reviewed in Rev 3.1)

7. **The HCM `queryTransactions` contract is mandatory.** Status: documented (TRD §13.2.1). Real vendors that can't synthesize the lookup reduce the system's exactly-once guarantee to "best effort with reconciliation backstop." This is the most consequential constraint we put on adapter implementers.
8. **`TAKEN` is no longer strictly happy terminal.** Status: documented loudly; still a real risk if downstream code is owned by another team that misses the memo.
9. **~~`ReconciliationStep` table will grow unboundedly without an archival policy.~~** Status: partially mitigated in Rev 3.1 (Q.θ snapshot summarization addresses the larger `ProvisionalAction` storage growth); `ReconciliationStep` itself still grows, but each row is small. Archival to cold storage is operational future work.
10. **The `MockHcmTestHarness` is testing infrastructure that itself can fail.** Status: mitigated by Layer 24 self-tests; still a single point of correctness for the whole test suite.
11. **The cancellation acknowledgment flag is a UI-server trust boundary.** Status: documented (ADR-016). A buggy UI could set the flag without rendering the warning — auditable but not preventable server-side.
12. **Pair-coalescing assumes the state machine prevents pathological chains.** Status: tested explicitly (T-PC-04, T-PC-05). If the state machine ever permits a new transition that breaks the assumption, pair-coalescing's correctness reasoning falls.

### 11.3 Rev 3.1 new (small) risks

13. **`reconciler.historyQueryWindowMs` default 24h might be wrong for long outages.** A multi-day HCM outage combined with reconciler delay >24h could place the query window before any HCM transaction. Mitigated by HCM's own idempotency-key handling (still dedupes) and Layer 7 daily reconciliation (catches drift). Configurable.
14. **`ReconcilerLease` TTL of 60s might be wrong for very-large reconciliation batches.** A reconciler tick that takes longer than 60s could have its lease stolen mid-tick, leading to potential duplicate work. Mitigated by the step log's resume semantics (the new worker reads where the previous one left off). Configurable; default should be safe for any reasonable batch size.
15. **Snapshot summarization is irreversible.** Once `localStateSnapshot` is nulled on CONFIRMED, there's no way to recover the full state. If a CONFIRMED action is later disputed, the summary may be insufficient for deep forensic work. Mitigated by `reconciler.snapshotRetention.summarizeAfterSuccess = false` configuration option (defaults to true; compliance-heavy deployments may flip it).
16. **HR Review Queue `totalCount` could be expensive at scale.** Computed against the filter; depends on database engine. Index on `(category, flaggedAt)` keeps it tractable for current-size queues; very-large backlogs would need an estimate. Future work.
17. **`MetricsAdapter` no-op default means metrics silently don't emit unless wired.** Operators deploying to production must remember to configure the adapter. Mitigated by a startup log warning when no adapter is configured.

Each risk is acceptable for the brief's scope. None is a surprise.

---

## 12. SQLite-to-Postgres migration shape (Rev 3, Q.η)

The brief requires SQLite for this exercise, and the design as documented uses SQLite throughout. This section outlines what a production-grade follow-up would change when moving to Postgres. It's reasoning, not a plan — the brief stays on SQLite.

### 12.1 What stays the same

- **Module hierarchy.** All modules in `04_Module_Plan.md §2` are storage-agnostic at the service layer.
- **Repository surfaces.** All interfaces in `04_Module_Plan.md §5` work for both engines.
- **Mock HCM.** Stays on SQLite — it's per-test-isolated, doesn't need scale, and adding a second engine dependency to the test infrastructure is pointless.
- **Idempotency contracts.** Canonical input serializer, GraphQL idempotency keys, all unchanged.
- **State machines.** Unchanged.
- **Test plan.** Unchanged — tests are storage-agnostic at the service surface. Integration tests would acquire a Postgres test container; everything else is identical.

### 12.2 What changes

- **Concurrent writers.** SQLite's `BEGIN IMMEDIATE` becomes a serialization bottleneck under load. Postgres allows true concurrent writes with row-level locks.
- **Outbox claim.** From `BEGIN IMMEDIATE` + `UPDATE ... RETURNING` to `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE`. Allows multiple worker processes to drain in parallel.
- **Polling can become push.** `LISTEN/NOTIFY` allows the outbox worker to wake on enqueue instead of polling at a fixed interval. Latency drops from up-to-1-second to near-zero. Polling is kept as a fallback for missed notifications.
- **Advisory lock.** `pg_advisory_lock` (session-scoped) replaces the single-row lease table for the provisional reconciler. Cleaner than a row-update pattern; the lock is automatically released on session disconnect (handles worker crashes).
- **Append-only triggers.** Postgres triggers for `ProvisionalAction` and `ReconciliationStep` are easier to write and easier to maintain than SQLite's variant. Still optional; repository convention remains the primary enforcement.
- **Multi-process.** Multiple worker instances behind a coordinator. The advisory lock and `SKIP LOCKED` claim together provide the coordination.
- **Connection pooling.** PgBouncer or equivalent. SQLite has no such concept.
- **Decimal storage.** Postgres `NUMERIC(precision, scale)` becomes available as the native storage type. `decimal.js` would still parse/serialize on the application side, but the storage type would be richer than SQLite's `TEXT`.

### 12.3 Why we don't do it now

- The brief says SQLite. The brief is authoritative.
- The exercise is one bounded context with human-scale write rates. SQLite is more than adequate.
- The single-process polling model is operationally simpler and easier to reason about for the take-home.
- Migration to Postgres is a real engineering effort but it's mechanical, not architectural — the design is intentionally portable.

### 12.4 What to test before migrating

- **Concurrent reconciler ticks.** Currently the advisory lock prevents this. Test that under Postgres, the new lock primitive provides equivalent semantics under simulated multi-process load.
- **Outbox claim under concurrency.** `SKIP LOCKED` doesn't give FIFO ordering across workers; verify this is acceptable (it is, for our retry semantics).
- **`LISTEN/NOTIFY` reliability.** Must remain backed by polling for missed notifications — never sole mechanism.
- **Append-only triggers under Postgres syntax.** Different DDL; same semantics.
- **Decimal round-tripping through `NUMERIC`.** No precision should be lost.

The migration is forward work for a production environment, deferred for this exercise per spec.
