# Employee Bootstrap Runbook

> **Audience:** support / on-call engineer fielding "employee not found" reports.
> **Spec:** TRD §11, ADR-012.

## Three paths

The service learns about new employees through three independent paths (TRD §11.5):

1. **Webhook** (`EMPLOYEE_CREATED`) — fast, lossy primary path.
2. **Lazy pull** — on-demand at first API touch; safety net for missed webhooks.
3. **Daily batch** — unconditional convergence path.

An `Employee` row exists ⇔ the employee is operable by this service.

## Symptom → diagnosis

### Symptom: API returns `EMPLOYEE_NOT_BOOTSTRAPPED`

The employee is unknown to us and the lazy-pull HCM lookup returned 404. Either HCM doesn't know about them, or HCM is currently unreachable AND the employee has never been seen via webhook or batch.

1. **Check HCM directly.** Does the employee exist in HCM?
   - If no: HCM data correction needed. Not a service issue.
   - If yes: continue.
2. **Check `hcmHealth`.** If HCM was unreachable at the time, the lazy pull couldn't run. The next daily batch will bootstrap them, or a manual retry once HCM is back will work.
3. **Check audit log** for `EMPLOYEE_BOOTSTRAPPED` events on this employee. If none, no path has run yet for them. Trigger a manual lazy pull by re-issuing the failed mutation.

### Symptom: API returns dimensions errors (`LEAVE_TYPE_NOT_AVAILABLE`, `EMPLOYMENT_NOT_FOUND`) for a brand-new hire

Bootstrap may have run but populated incomplete data. Re-trigger batch reconciliation (`triggerReconciliation`) — it pulls every dimension fresh from HCM.

## Race conditions

Webhook and lazy pull may race. Both paths use `INSERT OR IGNORE` on `Employee`, so concurrent attempts merge cleanly — only the first insert wins, and subsequent operations on the same employee succeed. No manual cleanup is ever required.

## Worst case

Daily batch is the unconditional catch-up. Any employee in HCM is in our `Employee` table within 24 hours via batch alone. If batch fails persistently, ops escalation.
