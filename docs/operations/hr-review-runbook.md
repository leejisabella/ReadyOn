# HR Review Queue Runbook

> **Audience:** HR users resolving irregular time-off requests.
> **Spec:** TRD §9.5.5, §7.1, ADR-017, ADR-026.

## What the queue surfaces

Three categories of request need human attention because software cannot resolve them:

| Category | Meaning | Typical resolution |
|---|---|---|
| `ESCALATED_PRE_LEAVE` | HCM rejected a provisional approval before the leave was taken | Cancel the request or rebalance manually |
| `ESCALATED_POST_LEAVE` | HCM rejected a provisional approval after the leave was taken — `TAKEN` with `hrReviewFlag = true` | Manual entry into HCM, payroll adjustment, or other reconciliation |
| `CANCELLATION_STUCK` | A cancellation has been pending longer than `cancellationPendingAlertThresholdMs` (default 1h) | Investigate why HCM credit isn't completing; may need manual HCM ticket |

## Query

```graphql
query {
  hrReviewQueue(categories: [ESCALATED_PRE_LEAVE, ESCALATED_POST_LEAVE], first: 50) {
    totalCount
    edges {
      cursor
      node {
        category
        flaggedAt
        reason
        request { id employeeId locationId leaveTypeId units state }
        provisionalActions {
          invokedBy
          invokedAt
          reason
          reconciliationState
          reconciliationSteps {
            kind
            outcome
            occurredAt
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

Pagination is forward-only Relay-style (ADR-026). Use `pageInfo.endCursor` as `after` for the next page.

## Resolution workflows

### ESCALATED_PRE_LEAVE

The leave hasn't happened yet. HR options:

1. **Cancel the request locally.** Use `cancelTimeOffRequest`; the cancellation will reconcile against HCM (which never debited).
2. **Adjust HCM** so that a re-approval would succeed (e.g., add balance manually), then create a new request and approve normally.

### ESCALATED_POST_LEAVE

The leave already happened. HR must:

1. Read the full audit chain via `provisionalActions[].reconciliationSteps`. The chain shows when break-glass was invoked, who invoked, what HCM said when queried.
2. Inspect the original `localStateSnapshot` on the `ProvisionalAction` — it's retained in full for ESCALATED outcomes (ADR-022). It shows what balance/employment state existed at the moment of decision.
3. Determine manual remediation: most often this means entering the leave directly into HCM with a backdated effective date, or adjusting the employee's PTO ledger in payroll.

### CANCELLATION_STUCK

The cancellation has been retrying without success. Likely causes:

- HCM is rejecting the credit (rare; idempotency replay should have returned prior success). Investigate HCM-side state.
- The retry budget is exhausted. Reset the outbox entry (ops only).

## Audit chain

Every HR review item carries its full reconciliation lineage. For any decision shown in the queue, you can walk:

```
HrReviewItem
  → request (TimeOffRequest with state and timestamps)
  → provisionalActions
      → ProvisionalAction (with localStateSnapshot retained on escalation)
      → reconciliationSteps (every step the reconciler took, in order)
  → AuditEvents linked via correlationId
```

This is sufficient to reconstruct any case end-to-end.

## What HR does NOT do

- HR doesn't approve normal requests. That's a manager-role workflow.
- HR doesn't invoke break-glass. That's a `break_glass_approver` role.
- HR doesn't edit `ProvisionalAction` or `ReconciliationStep` rows. They are append-only; resolutions are external (HCM adjustment, payroll memo).
