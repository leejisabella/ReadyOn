# Extension Roadmap

This document is the authoritative record of every TRD-specified feature that is **not implemented in the current code** — what's missing, why we deferred it, and the concrete path to adding it if a future product cycle prioritises it.

> **Why this file exists.** The TRD describes a more elaborate system than the brief required. Each section below states (a) what the TRD specs, (b) what the brief required, (c) what we built, and (d) the exact diff needed to close the gap. The audit chain is honest: nothing is hand-waved.

## Summary

| # | Gap | TRD § | Brief mandate? | Effort | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `ingestHcmEvent` GraphQL mutation | §7.1 | No — brief says "REST (or GraphQL) endpoints," doesn't dictate names | ~30 min | Functional equivalent shipped (HTTP webhook) |
| 2 | Drift classification on batch reconciliation | §10.2 | No — brief requires *handling* anniversary/year-refresh (done), not *classifying* drift | ~½ day after policy data lands | Deferred behind policy-config dependency |
| 3 | Remaining TRD §16 config knobs (`outbox.*`, `inbox.*`, retention, policy hints) | §16 | No — brief doesn't enumerate config surface | ~½ day | Deferred — current defaults are correct |

None of the three are required by the brief. All three are reasonable future extensions; each is documented at runbook-level so an operator can spot the gap before assuming the spec'd behaviour.

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

## Closing thoughts

Every gap in this file is a **documented choice**, not an oversight. The default in each case ("don't ship") was driven by one of:

- "Brief doesn't ask for it" (Flag 1)
- "Spec needs prerequisite data we don't load yet" (Flag 2)
- "Knob is correctly defaulted and env-tunability is YAGNI without observed need" (Flag 3)

Each section above gives the operator (or the next contributor) enough detail to close the gap in a single small slice. The system as it stands satisfies the brief and the test suite covers regressions on the code paths that DO exist.
