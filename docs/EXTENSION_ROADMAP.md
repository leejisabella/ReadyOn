# Extension Roadmap

This document is the authoritative record of every TRD-specified feature that is **not implemented in the current code** — what's missing, why we deferred it, and the concrete path to adding it if a future product cycle prioritises it.

> **Why this file exists.** The TRD describes a more elaborate system than the brief required. Each section below states (a) what the TRD specs, (b) what the brief required, (c) what we built, and (d) the exact diff needed to close the gap. The audit chain is honest: nothing is hand-waved.

## Summary

| # | Gap | TRD § | Brief mandate? | Effort | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `ingestHcmEvent` GraphQL mutation | §7.1 | No — brief says "REST (or GraphQL) endpoints," doesn't dictate names | ~30 min | Functional equivalent shipped (HTTP webhook) |
| 2 | Drift classification on batch reconciliation | §10.2 | No — brief requires *handling* anniversary/year-refresh (done), not *classifying* drift | ~½ day after policy data lands | Deferred behind policy-config dependency |
| 3 | Remaining TRD §16 config knobs (`outbox.*`, `inbox.*`, retention, policy hints) | §16 | No — brief doesn't enumerate config surface | ~½ day | Deferred — current defaults are correct |
| 4 | Mock HCM adversarial modes + reachability toggle | §17.3 | No — brief asks for "basic logic to simulate balance changes" | ~2 days | Deferred — admin seeding + harness covers brief |

None of the four are required by the brief. All four are reasonable future extensions; each is documented at runbook-level so an operator can spot the gap before assuming the spec'd behaviour.

---

## Flag 1 — `ingestHcmEvent` GraphQL mutation (TRD §7.1)

### What the TRD specs

```graphql
type Mutation {
  # Internal — protected at gateway
  ingestHcmEvent(input: HcmEventInput!): IngestPayload!
}
```

An internal-only mutation that the gateway can call to feed an HCM event into the inbox.

### What the brief required

> "REST (or GraphQL) endpoints for handling time off balances and syncing them up with HCMs."

The brief doesn't dictate any particular ingestion path. It does require ingestion to *work*.

### What we built

An HTTP webhook controller at `POST /webhooks/hcm`:

- Defined in [`webhook.controller.ts`](../apps/service/src/infrastructure/inbox/webhook.controller.ts)
- Authenticates via HMAC signature (`x-hcm-signature` header verified against a per-tenant secret)
- Validates the envelope (`eventId`, `type`, `hcmVersion`, `appliedAt`, `payload`) via zod
- Writes to `inbox_event` via `InboxStore.ingest()` and returns 2xx immediately
- The `InboxProcessor` worker drains the table asynchronously and routes each event to the right domain service

### Why we deferred

The HTTP webhook is the **idiomatic** ingestion path for HCM event delivery. In production, an HCM like Workday or SAP pushes events via HTTP — they don't make GraphQL calls. The TRD's `ingestHcmEvent` mutation reads as an operational trigger ("ops can manually inject an event for testing"), not as the primary HCM-driven path.

Functionally, the two are equivalent: both land a validated envelope in `inbox_event`; both are then drained by `InboxProcessor`. The HTTP webhook is just better-suited to the actual producer (HCM).

### How to add it if you want literal TRD parity

1. Create an input type:
   ```ts
   // apps/service/src/api/inputs/hcm-event.input.ts
   @InputType('HcmEventInput')
   export class HcmEventInput {
     @Field(() => ID) readonly eventId!: string;
     @Field() readonly type!: 'BALANCE_UPDATED' | 'EMPLOYMENT_CHANGED'
                              | 'LEAVE_TYPE_CHANGED' | 'EMPLOYEE_CREATED';
     @Field(() => String) readonly hcmVersion!: string; // bigint as string
     @Field(() => DateTime) readonly appliedAt!: string;
     @Field(() => GraphQLJSON) readonly payload!: Record<string, unknown>;
   }
   ```
2. Add a payload type with the standard `{ accepted, eventId }` envelope.
3. Add the mutation to `AdminResolver`:
   ```ts
   @Mutation(() => IngestPayload, { description: 'TRD §7.1 (internal — gateway-protected)' })
   ingestHcmEvent(@Args('input') input: HcmEventInput): IngestPayload {
     const accepted = this.inbox.ingest({
       id: input.eventId,
       source: 'GRAPHQL',
       type: input.type,
       payload: input.payload,
       hcmVersion: BigInt(input.hcmVersion),
       receivedAt: new Date().toISOString(),
     });
     return { accepted, eventId: input.eventId };
   }
   ```
4. Inject `InboxStore` into `AdminResolver`.
5. Add a test mirroring the existing webhook controller spec but via the GraphQL endpoint.

### Estimated effort

~30 minutes. Smallest of the four.

---

## Flag 2 — Drift classification on batch reconciliation (TRD §10.2)

### What the TRD specs

When the daily batch reconciler observes that a local row disagrees with HCM's corpus, it should classify the divergence into one of:

| Class | Meaning | Operator response |
| --- | --- | --- |
| `ANNIVERSARY_BUMP` | Employee crossed their hire-anniversary; HCM added accrued PTO | Expected — log, no action |
| `ANNUAL_REFRESH` | Fiscal-year reset; HCM zeroed/topped-up balances | Expected — log, no action |
| `MISSED_WEBHOOK` | The change matches what a `BALANCE_UPDATED` webhook should have delivered, but we have no `inbox_event` record of it | **Alarming** — investigate webhook plumbing |
| `RETRO_CORRECTION` | HCM applied a backdated correction to a past period | **Alarming** — HR may need to inform affected employee |
| `UNKNOWN_DRIFT` | None of the above fit | **Most alarming** — fundamental sync gap |

The classification is audit-logged and intended to drive operator alerting.

### What the brief required

> "ReadyOn is not the only system that updates HCM; for example on work anniversary or start of the year, our customers' employees may get a refresh of time off balances."

The brief requires the system to **handle** out-of-band HCM updates. It does **not** require classifying them into categories — that's TRD-level operational telemetry.

### What we built

`BatchReconciliation.tick()` in [`batch-reconciliation.service.ts`](../apps/service/src/infrastructure/reconciliation/batch-reconciliation.service.ts):

- Streams every row from `/balances/batch`
- For each, compares `hcmVersion` against local
- Applies newer-version rows via `BalanceService.applyHcmUpdate()`
- Reports `{ inspected, applied, skipped }` summary counts

Convergence is correct — local always lands on HCM's current view. **No classification metadata is produced.**

### Why we deferred

The TRD-spec'd classifier is a **heuristic** function. To produce useful classifications, it needs policy data the codebase doesn't load:

| Classification | Data needed |
| --- | --- |
| `ANNIVERSARY_BUMP` | Per-employee hire-anniversary date + per-leave-type accrual rate |
| `ANNUAL_REFRESH` | Tenant fiscal-year boundary + per-leave-type annual allocation |
| `MISSED_WEBHOOK` | Cross-reference inbox for a webhook event matching this row's delta + timing |
| `RETRO_CORRECTION` | Distinguish `appliedAt` (when HCM recorded the change) from `effectiveAt` (when the change took effect) |

Of the five categories, only `MISSED_WEBHOOK` is implementable today (we have `inbox_event` to cross-reference). The other four require policy config the HCM port doesn't currently expose.

**The failure mode of shipping without policy data:** the classifier would either return `UNKNOWN_DRIFT` for everything (noise without signal) or confidently mis-classify (a small `RETRO_CORRECTION` mistaken for an `ANNIVERSARY_BUMP` because we have to guess at the anniversary date). Both outcomes are *worse than not classifying* — the first dilutes the signal, the second poisons operator trust.

The TRD's own §16 anticipates the policy-config dependency: `policy.advanceLeaveToleranceUnits` and `policy.leaveTypePrecision` are both per-leave-type and currently unwired. A real drift classifier belongs in the same wave as that policy work.

### How to add it if you want it

**Option A — Full TRD-spec'd classifier (recommended once policy data lands).**

1. Add policy infrastructure (~1 slice on its own):
   - Extend `HcmPort.fetchEmployee` to include `hireDate` (anniversary marker).
   - Add a `LeaveTypePolicy` projection (`accrualRatePerYear`, `annualAllocation`).
   - Add a `TenantPolicy` config field (`fiscalYearStart`).
2. Add the classifier as a pure function:
   ```ts
   // apps/service/src/infrastructure/reconciliation/drift-classifier.ts
   export type DriftClass =
     | 'ANNIVERSARY_BUMP'
     | 'ANNUAL_REFRESH'
     | 'MISSED_WEBHOOK'
     | 'RETRO_CORRECTION'
     | 'UNKNOWN_DRIFT';

   export function classifyDrift(args: {
     localRow: BalanceRow;
     hcmRow: HcmBatchEntry;
     policy: { ... };
     inboxLookup: (key: ...) => InboxRow | null;
   }): DriftClass {
     // 1. inbox lookup → MISSED_WEBHOOK if no match
     // 2. anniversary date ± 1 day + delta matches accrual rate → ANNIVERSARY_BUMP
     // 3. fiscal-year-start ± 7 days + delta matches annual allocation → ANNUAL_REFRESH
     // 4. effectiveAt < localRow.hcmEffectiveAt → RETRO_CORRECTION
     // 5. else → UNKNOWN_DRIFT
   }
   ```
3. Add a `BALANCE_RECONCILIATION_APPLIED` audit action (re-add to [`audit-event.types.ts`](../apps/service/src/infrastructure/observability/audit-event.types.ts)) with `MEDIUM` severity for alarming classes.
4. Wire emission inside `BatchReconciliation.tick()` after each `applyHcmUpdate`.
5. Add a metrics gauge `batch_drift_count` tagged by classification.
6. Update [`reconciliation-runbook.md`](operations/reconciliation-runbook.md) to remove the "not yet implemented" note.
7. Tests: one per classification branch + one composite test of the runbook's "what should I do when X fires" workflow.

**Option B — Stepping-stone (`MISSED_WEBHOOK` only).**

Implementable today without policy data. ~2 hours. Same audit/metric scaffolding; classifier collapses to "matched inbox row? → reconciled; absent? → MISSED_WEBHOOK; else → not classified."

### Estimated effort

- Full TRD-spec'd: ~½ day after the policy-data slice lands (which is ~1 slice on its own).
- Stepping-stone: ~2 hours, ship anytime.

---

## Flag 3 — Remaining TRD §16 config knobs

### What the TRD specs

[`docs/01_TRD.md` §16](01_TRD.md) lists a `ServiceConfig` interface covering ~20 knobs across `hcm`, `outbox`, `inbox`, `reconciliation`, `reconciler`, `idempotency`, `breakGlass`, `cancellation`, `policy`.

### What the brief required

The brief doesn't enumerate config surface. It implicitly requires correctness of the operation each knob would govern.

### What we built

[`service-config.ts`](../apps/service/src/infrastructure/config/service-config.ts) covers every knob the code currently consumes:

| TRD §16 knob | Status |
| --- | --- |
| `hcm.baseUrl` / `timeout` | ✅ wired |
| `hcm.healthRecoveryWindowMs` | ✅ wired (as `HCM_HEALTHY_AFTER_MS`) |
| `breakGlass.minOutageMs` / `requireRole` | ✅ wired |
| `reconciler.historyQueryWindowMs` / `staleAfterMs` / `leaseTtlMs` | ✅ wired (named `RECONCILER_*` envs) |
| `reconciliation.staleBalanceThresholdMs` | ✅ wired |
| `cancellation.pendingAlertThresholdMs` | ✅ wired |
| `idempotency.keyTtlMs` | ⚠️ hardcoded constant in `idempotency.service.ts` (not env-tunable) |
| `outbox.*` (5 knobs) | ⚠️ hardcoded inside `OutboxWorker` defaults |
| `inbox.*` (2 knobs) | ⚠️ hardcoded inside `InboxProcessor` defaults |
| `reconciliation.pointReadDelayMs` / `pointReadJitterMs` / `pointReadMaxRatePerSecond` | ⚠️ hardcoded in `PointReadScheduler` |
| `reconciliation.driftSweepIntervalMs` / `fullBatchIntervalMs` | ⚠️ no scheduler invokes drift/batch on a timer — only on demand via `triggerReconciliation` |
| `reconciler.provisionalIntervalMs` | ⚠️ same — no timer; only `triggerProvisionalReconciliation` |
| `reconciler.staleAlertMetricName` | ⚠️ hardcoded as `'reconciler.provisional_action_stale_count'` |
| `reconciler.snapshotRetention.summarizeAfterSuccess` | ⚠️ hardcoded to `true` (see [provisional-reconciler-runbook.md](operations/provisional-reconciler-runbook.md) "Snapshot retention") |
| `reconciler.snapshotRetention.retainFullSnapshotForEscalated` | ⚠️ hardcoded to `true` |
| `policy.advanceLeaveToleranceUnits` | ⚠️ not consumed by the saga |
| `policy.leaveTypePrecision` | ⚠️ not consumed |

The unconsumed knobs fall into two groups:

- **Hardcoded defaults that match the TRD spec.** Operationally fine; just not env-tunable. Examples: `outbox.pollingIntervalMs = 1000`, `inbox.batchSize = 50`.
- **Knobs that govern features not yet wired.** Example: `reconciler.snapshotRetention.summarizeAfterSuccess = false` would change reconciler behaviour, but the alternative path is unwired so the flag would be inert.

### Why we deferred

None of these affect correctness or the brief's requirements. They affect ops tunability — useful only after the system has been deployed and operators have observed real workloads. Shipping with TRD-default values is correct; shipping a config surface that's never tweaked is YAGNI.

### How to add it

Trivial per knob — extend `ServiceConfig` + `env-schema.ts`, pass the slice through `AppModule.forRoot` to the relevant `Module.forRoot`. Each takes ~10 minutes including a Zod test for the env-parsing path. The full set is ~½ day.

The schedulers for `driftSweepIntervalMs` / `fullBatchIntervalMs` / `provisionalIntervalMs` are slightly bigger — they need a `@nestjs/schedule` cron registration or a setInterval handler in each worker module. That's another ~½ day on top.

### Estimated effort

- Env-knob plumbing only: ~½ day.
- Including the periodic-trigger schedulers: ~1 day total.

---

## Flag 4 — Mock HCM adversarial modes + reachability toggle (TRD §17.3)

### What the TRD specs

The Mock HCM should support a `setMode(mode)` admin endpoint that switches its response behaviour:

| Mode | Behaviour |
| --- | --- |
| `normal` | Honest (default) |
| `flaky` | Random 5xx and timeouts at a configurable rate |
| `silent_no_op` | `200 OK` with `deltaApplied = 0` (correctness trap — adapter must catch via ADR-005 `deltaApplied` check) |
| `wrong_delta` | `200 OK` with `deltaApplied != requested` |
| `missing_confirmation` | `200 OK` with required ADR-005 fields omitted |
| `stale_version` | `200 OK` with `hcmVersion ≤ current` |
| `malformed` | Garbage JSON / wrong shape (adapter must throw `HcmContractViolation`) |
| `slow` | Adds configurable latency (timeout enforcement test) |

Plus a `setReachability(state)` toggle for full-outage simulation.

### What the brief required

> "Create mock endpoints (you may want to deploy real mock servers for them with some basic logic to simulate balance changes)."

"Basic logic to simulate balance changes" — satisfied by our admin endpoints (`/admin/setBalance`, `/admin/setEmployment`, `/admin/setLeaveTypeAvailability`, `/admin/seedTransaction`, `/admin/deleteEmployee`, `/admin/reset`). The brief doesn't ask for fault injection.

### What we built

The mock runs in **honest `normal` mode only**. The `MockHcmTestHarness` exposes `setMode` / `setReachability` / webhook-scheduling methods that throw `MockHcmHarnessError` with a clear "not implemented in the mock" message when called with a non-trivial argument:

```ts
async setMode(mode: MockHcmMode): Promise<void> {
  if (mode !== 'normal') {
    throw new MockHcmHarnessError(`Adversarial mode '${mode}' is not implemented in the mock.`);
  }
}
```

Tests that need adversarial scenarios (HCM rejection, EMPLOYEE_NOT_FOUND, mismatched delta) achieve them by **seeding** the mock's underlying state directly — e.g., setting an absurd balance so `reserveBalance` returns `INSUFFICIENT_BALANCE`, or planting a transaction with a wrong delta for the history-mismatch test. These cover the same code paths the adversarial modes would, just at a different test seam.

### Why we deferred

Three reasons:

1. **The brief doesn't ask for it.** The brief asks for "basic logic" — admin seeding meets that bar.
2. **The relevant defensive code is already covered.** The HCM adapter's zod-validation path is exercised by [`mock-hcm.adapter.spec.ts`](../apps/service/src/infrastructure/hcm/mock-hcm.adapter.spec.ts) and the canonical-input serializer tests. Adversarial modes would re-exercise the same code paths — they'd add depth to the test surface (genuine fault injection vs. unit-test stubbing) but not coverage of new code.
3. **It's a real build, not a refactor.** A working adversarial-mode system needs: a mode controller in the mock; a request-interceptor that mutates the response per mode; a flaky-mode RNG with configurable rates; a slow-mode timer; a stale_version state tracker. Then the harness has to surface deterministic toggles for tests (not just "be flaky" but "be flaky for the next N calls"). That's a full slice on its own.

### How to add it

A clean implementation, split across two phases:

**Phase A — Reachability + slow + malformed (the "simulate outage" subset, ~½ day).**

These are the modes the existing test suite would benefit from most.

1. Add a `ModeStore` in `apps/mock-hcm/src/persistence/` holding `{ mode, reachability }` in-memory.
2. Add admin endpoints:
   ```ts
   POST /admin/setMode         { mode: MockHcmMode }
   POST /admin/setReachability { state: 'on' | 'off' }
   ```
3. Add a NestJS interceptor `AdversarialModeInterceptor` on every API route that consults `ModeStore`:
   - `reachability = 'off'` → return `503` without touching DB
   - `mode = 'slow'` → `await setTimeout(latencyMs)` before the handler
   - `mode = 'malformed'` → return `res.send('}{not json')` after the handler
4. Wire the harness `setMode` / `setReachability` to actually `POST /admin/setMode` etc., remove the stubs.
5. Add tests: one per mode showing the adapter's defensive layer catches it correctly (e.g., `slow` triggers timeout, `malformed` throws `HcmContractViolation`, `off` triggers `HcmTransientError`).

**Phase B — Correctness traps: `silent_no_op` / `wrong_delta` / `missing_confirmation` / `stale_version` / `flaky` (~1 day).**

These need response mutation rather than just rejection. The interceptor pattern extends:

- For mutation endpoints, the interceptor wraps the handler's response and tweaks specific fields per mode.
- `flaky` needs a configurable rate (`POST /admin/setMode { mode: 'flaky', failureRate: 0.5 }`) and a deterministic test mode where the next N calls fail (so tests aren't flaky themselves).
- Each mode gets a paired adapter test confirming the right defensive layer fires:
  - `silent_no_op` → adapter detects `deltaApplied = 0` → throws `HcmContractViolation`
  - `wrong_delta` → adapter detects mismatch → audit `HCM_RESPONSE_INVALID` (a code that already exists)
  - `missing_confirmation` → zod rejects the response → `HcmContractViolation`
  - `stale_version` → applyHcmUpdate skips the row (`hcmVersion` not newer)

### Estimated effort

- Phase A alone: ~½ day, ships meaningful E2E outage scenarios.
- Both phases: ~1.5 – 2 days.

The brief explicitly says "agentic development; do not write even a single line of code." If a future test cycle wants real fault injection beyond the admin-seed approach, Phase A is the high-value chunk.

---

## Closing thoughts

Every gap in this file is a **documented choice**, not an oversight. The default in each case ("don't ship") was driven by one of:

- "Brief doesn't ask for it" (Flag 1, 4)
- "Spec needs prerequisite data we don't load yet" (Flag 2)
- "Knob is correctly defaulted and env-tunability is YAGNI without observed need" (Flag 3)

Each section above gives the operator (or the next contributor) enough detail to close the gap in a single small slice. The system as it stands satisfies the brief and the test suite covers regressions on the code paths that DO exist.
