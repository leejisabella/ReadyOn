# Reconciliation Runbook

> **Audience:** on-call engineer triaging drift between local projection and HCM.
> **Spec:** TRD §10, §13.5, ADR-009.

## Three normal cadences

The service runs three independent reconciliation cadences against HCM (TRD §10.4, §13.5). All three live in [`ReconciliationModule`](../../apps/service/src/infrastructure/reconciliation/reconciliation.module.ts):

| Cadence | Trigger | Purpose |
|---|---|---|
| **Point-read** | After every successful HCM commit, `pointReadDelayMs` later (with jitter and per-balance coalescing — TRD §10.4) | Catch discrepancy that schema validation missed |
| **Drift sweep** | Periodic walk over balances whose `last_reconciled_at` is older than `RECONCILIATION_STALE_BALANCE_THRESHOLD_MS` (default 5 min) | Schedule point-reads against any balance that's gone stale |
| **Batch** | Daily HCM corpus pull (`/balances/batch` NDJSON stream) | Convergence path; catches webhook gaps |

For any drift to persist past 24 hours, all three must fail at once.

## Triggering reconciliation on demand

Two GraphQL mutations forcibly tick a cadence (gateway-protected internal endpoints):

```graphql
mutation { triggerReconciliation { kind inspected applied skipped } }
mutation { triggerProvisionalReconciliation { kind inspected applied skipped } }
```

`triggerReconciliation` drains the full HCM corpus; `triggerProvisionalReconciliation` runs the provisional drainer (see [`provisional-reconciler-runbook.md`](provisional-reconciler-runbook.md)).

## Symptom → diagnosis

### Symptom: balance differs between local view and HCM for an extended period

1. **Trigger an on-demand batch reconciliation** via `triggerReconciliation`. The result reports `inspected` / `applied` / `skipped` counts.
2. **Check the inbox processor** for failures on `BALANCE_UPDATED` events — a stuck webhook is the most common cause of persistent drift.
3. **Inspect the balance row's `state`.** `UNDER_HOLD_DEFICIT` indicates HCM applied a balance reduction that brought `available` below the sum of holds (next section). `RECONCILING` indicates a reconciler is currently working on it.

### Symptom: many `UNDER_HOLD_DEFICIT` balances appearing

HCM applied a balance reduction (e.g., a retroactive correction) that brought `available` below `pending + approved + provisional`. The state derivation is in [`balance.service.ts`](../../apps/service/src/domain/balance/balance.service.ts) (`derive()` at the bottom).

Today these rows are detected and flagged. Auto-revalidation of affected requests (TRD §6.2 `NEEDS_REVALIDATION` transition) is not yet wired — investigate the affected requests manually.

### Symptom: daily batch reconciliation is taking too long

Inspect the inbox queue depth. If the batch is producing more events than the processor can drain, queues grow until the next batch. Knobs:

- `INBOX_BATCH_SIZE` (TRD §16, not yet env-configurable — defaults inside `InboxProcessor`)
- HCM batch endpoint pagination (mock today streams everything in one response)

## Not yet implemented

- **Drift classification** (TRD §10.2 — `ANNIVERSARY_BUMP`, `ANNUAL_REFRESH`, `MISSED_WEBHOOK`, `RETRO_CORRECTION`, `UNKNOWN_DRIFT`) is described in the spec but not produced by the current batch reconciler. The reconciler applies newer-`hcmVersion` rows without categorising them.
- **`BALANCE_RECONCILIATION_APPLIED` audit events** are not emitted. The audit catalogue today covers the saga and the provisional reconciler — see [`audit-event.types.ts`](../../apps/service/src/infrastructure/observability/audit-event.types.ts).

## Provisional reconciler

Separate cadence; see [`provisional-reconciler-runbook.md`](provisional-reconciler-runbook.md).
