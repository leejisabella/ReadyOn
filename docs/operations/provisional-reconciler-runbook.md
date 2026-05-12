# Provisional Reconciler Runbook

> **Audience:** on-call engineer monitoring break-glass invocations and the reconciler's exactly-once correctness.
> **Spec:** TRD §9.5.3, ADR-018, ADR-023, ADR-024, ADR-025, ADR-027.

## What the reconciler does

When HCM recovers, the `ProvisionalReconciler` drains pending `ProvisionalAction` rows by querying HCM's transaction history for matching idempotency keys, then either skipping (HCM already applied) or calling HCM (HCM hasn't yet), and recording every step in the append-only `ReconciliationStep` log. The combination guarantees exactly-once execution at the HCM boundary, verifiable from rows alone.

## Reading the `ReconciliationStep` log

```sql
SELECT step_sequence, kind, outcome, payload, occurred_at, worker_id
  FROM reconciliation_step
 WHERE action_id = ?
 ORDER BY step_sequence ASC;
```

Expected step sequence for a clean reconcile:

1. `HCM_HISTORY_QUERIED` (PARTIAL) — pre-flight transaction-history check.
2. `HCM_CALL_IN_FLIGHT` (PARTIAL) — only if history returned nothing.
3. `OUTCOME_APPLIED` (TERMINAL) — atomic with `ProvisionalAction.markReconciled`.

If history returned a matching transaction (HCM already applied), step 2 is skipped and `OUTCOME_APPLIED` references the existing transaction.

## Symptom → diagnosis

### Symptom: `PROVISIONAL_ACTION_STALE` audit event fired (and gauge `provisional_action_stale_count > 0`)

A `ProvisionalAction` has been `PENDING` for longer than `provisionalActionStaleAlertMs` (default 4h, ADR-025).

1. **Check `hcmHealth`.** If still UNHEALTHY, the outage exceeds normal expectations. Escalate to HCM ops.
2. **Check the last `ReconciliationStep`** for the stale action. If `HCM_HISTORY_QUERY_FAILED`, HCM is unreachable for the history-query call specifically — verify connectivity, not just liveness.
3. **Trigger a manual reconciler tick** via `triggerProvisionalReconciliation`. If lock is held, another worker is already running — wait.

### Symptom: Reconciler returned `DEFERRED` with reason `LOCK_UNAVAILABLE`

Another reconciler tick is in flight. Inspect the lease row:

```sql
SELECT * FROM reconciler_lease WHERE id = 'provisional';
```

`heldBy` shows which worker holds it; `expiresAt` shows when the lease auto-expires (ADR-023). If the holder has crashed, the lease will be reclaimable after `expiresAt` (default 60s). No manual intervention required.

### Symptom: `EMPLOYEE_NOT_FOUND_AT_HCM` ReconciliationStep recorded

The employee was deleted from HCM between break-glass invocation and reconciliation (ADR-027). The action is now `REJECTED_ESCALATED` and surfaces in `hrReviewQueue` with `hrReviewReason = "Employee no longer exists in HCM"`. The full `localStateSnapshot` is retained for HR investigation.

### Symptom: `HISTORY_MISMATCH` ReconciliationStep recorded

HCM has a transaction with our idempotency key but with a different delta. This means HCM applied something other than what we requested — operational anomaly. Action is `REJECTED_ESCALATED`. HR Review Queue surfaces the case. Investigate the HCM-side mismatch with HCM vendor.

## Manual replay

Today the only operator-facing trigger is the `triggerProvisionalReconciliation` mutation — it ticks the drainer once. Per-action replay CLI is not yet implemented; the reconciler's restart-safe step-log design means a stuck action is best surfaced via `PROVISIONAL_ACTION_STALE` and addressed by fixing the upstream cause (HCM, lease holder, etc.) rather than forcing a per-action retry.

## Snapshot retention

After `CONFIRMED` or `NO_OP`, the full `localStateSnapshot` is replaced with a compact `localStateSnapshotSummary` (ADR-022). Full snapshots are retained only for `REJECTED_ESCALATED` — those are the cases HR investigates. The retention policy is hardcoded today; the `reconciler.snapshotRetention.summarizeAfterSuccess = false` override from TRD §16 is not yet wired.
