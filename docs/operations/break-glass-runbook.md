# Break-Glass Runbook

> **Audience:** approvers with the `break_glass_approver` role and the on-call engineer who reviews invocations.
> **Spec:** TRD §9.5, ADR-011.

## When to invoke

Break-glass approval is available only when both conditions hold:

1. **HCM has been unreachable for at least `breakGlassMinOutageMs`** (default 60 seconds). Confirm via the `hcmHealth` GraphQL query: `reachable: false`, `outageStartedAt` set, `breakGlassAvailable: true`.
2. **Your account has the `break_glass_approver` role.** If you don't, the UI won't offer break-glass; the API will return `BREAK_GLASS_NOT_AUTHORIZED`.

## How to invoke

Use the `approveTimeOffRequestProvisionally` mutation. A non-empty `justification` field is required and is recorded in the audit chain.

```graphql
mutation {
  approveTimeOffRequestProvisionally(
    id: "<request-id>"
    approverId: "<your-id>"
    justification: "<why you approved without HCM>"
    idempotencyKey: "<UUID>"
  ) { ... }
}
```

The request transitions to `PROVISIONALLY_APPROVED`. The `ProvisionalAction` row records who, when, why, and a full local-state snapshot.

## What happens next

When HCM recovers, the `ProvisionalReconciler` drains the action:

- **HCM accepts** → request → `APPROVED`. Normal terminal state.
- **HCM rejects pre-leave** → request → `ESCALATED_TO_HR`. Surfaces in `hrReviewQueue`.
- **HCM rejects post-leave** → request → `TAKEN` with `hrReviewFlag = true`. Surfaces in `hrReviewQueue` under `ESCALATED_POST_LEAVE`.

## How to review afterward

Query `provisionalActions(filter: { invokedBy: "<your-id>" })`. Each row carries the reconciliation outcome and a full `reconciliationSteps` audit chain. Outcomes other than `CONFIRMED` should be reviewed by HR via `hrReviewQueue`.

## Forensic detail

If a reconciliation lands on `REJECTED_ESCALATED`, the full `localStateSnapshot` is retained (Rev 3.1, ADR-022). Use it to understand what the system believed at the moment of break-glass and what HCM later disagreed with.

## Anti-patterns

- **Don't use break-glass to bypass policy.** It's for HCM outages, not for routing around HCM's decisions.
- **Don't invoke for self.** Self-approval is rejected at the boundary.
- **Don't omit justification.** It's required and will appear in every audit downstream.
