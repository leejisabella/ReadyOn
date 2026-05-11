# Reconciliation Runbook

> **Audience:** on-call engineer triaging drift between local projection and HCM.
> **Spec:** TRD §10, §13.5, ADR-009.

## Three normal cadences

The service runs three independent reconciliation cadences against HCM (TRD §10.4, §13.5):

| Cadence | Trigger | Purpose |
|---|---|---|
| **Point-read** | After every successful HCM commit, `pointReadDelayMs` later (with jitter and per-balance coalescing) | Catch discrepancy that schema validation missed |
| **Drift sweep** | `driftSweepIntervalMs` (default 1h) | Periodic verification of all balances that have changed since last sweep |
| **Batch** | `fullBatchIntervalMs` (default 24h) | Full corpus pull; classifies divergences (`ANNIVERSARY_BUMP`, `ANNUAL_REFRESH`, `MISSED_WEBHOOK`, `RETRO_CORRECTION`, `UNKNOWN_DRIFT`) |

For any drift to persist past 24 hours, all three must fail at once.

## Symptom → diagnosis

### Symptom: Balance differs between UI and HCM for an extended period

1. **Trigger an on-demand reconciliation.** Use `triggerReconciliation(employeeId, locationId)` mutation.
2. **Inspect the audit log** for recent `BALANCE_RECONCILIATION_APPLIED` events on that balance row. The `classification` field tells you what kind of drift was detected.
3. **If the drift is recurring**, check the inbox processor for failures on `BALANCE_UPDATED` events — likely an HCM webhook is being rejected.

### Symptom: Many `UNDER_HOLD_DEFICIT` balances appearing

HCM applied a balance reduction (likely `RETRO_CORRECTION`) that brought `available` below `pendingHold + approvedHold + provisionalHold`. Affected requests are auto-flagged `NEEDS_REVALIDATION`. The reconciler converges them based on current HCM truth.

### Symptom: Daily batch reconciliation is taking too long

Check `fullBatchIntervalMs`, batch endpoint pagination, and the inbox processor's drain rate. If the batch is producing more events than the processor can drain, queues grow until next batch. Increase `inbox.batchSize` or scale HCM batch endpoint pagination.

## Provisional reconciler

Separate cadence; see `provisional-reconciler-runbook.md`.
