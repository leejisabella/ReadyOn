# Traceability Matrix — 80 Edge Cases → Test IDs

> **Authority:** TRD §15 (cases 1-80) · Test Plan §27 · Mini Tests §5.
> **Coverage:** 80 / 80 cases mapped. CI gate: any unmapped case fails the build.

Each row identifies the TRD §15 edge case, the test layer responsible, and the
concrete `*.spec.ts` file plus test ID(s) that exercise it. Adding a new case
to TRD §15 requires adding a row here and at least one named test.

## 1-3 — Concurrency

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 1 | Two concurrent approvals → HCM serializes | Property-based | [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | T-PROP-04, T-PROP-05 |
| 2 | Concurrent create + approve → no overlap | Property | [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | T-PROP-04 |
| 3 | Concurrent cancel + approval → state machine guards | State machine | [request-state-machine.spec.ts](../apps/service/src/domain/request/request-state-machine.spec.ts) | full transition matrix |

## 4-10 — HCM defensive

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 4 | HCM 200, no transaction confirmation → HcmContractViolation | Failure injection | [outbound-failure-injection.spec.ts](../apps/service/test/failure-injection/outbound-failure-injection.spec.ts) | T-FI-04 |
| 5 | HCM 200, deltaApplied=0 while requested ≠ 0 → SUSPECT_NO_OP | Failure injection | [outbound-failure-injection.spec.ts](../apps/service/test/failure-injection/outbound-failure-injection.spec.ts) | T-FI-02 |
| 6 | HCM 200, wrong delta → HcmContractViolation | Failure injection | [outbound-failure-injection.spec.ts](../apps/service/test/failure-injection/outbound-failure-injection.spec.ts) | T-FI-03 |
| 7 | HCM 200, stale hcmVersion → tolerated at adapter; domain rejects | Failure injection | [outbound-failure-injection.spec.ts](../apps/service/test/failure-injection/outbound-failure-injection.spec.ts) | T-FI-05 |
| 8 | HCM 5xx → retry | Failure injection | [outbound-failure-injection.spec.ts](../apps/service/test/failure-injection/outbound-failure-injection.spec.ts) | T-FI-01 |
| 9 | HCM timeout, request actually applied → retry returns prior result | Idempotency | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) · [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | idempotent replay tests |
| 10 | HCM malformed JSON → HcmContractViolation | Failure injection | [outbound-failure-injection.spec.ts](../apps/service/test/failure-injection/outbound-failure-injection.spec.ts) | T-FI-06 |

## 11-13 — HCM-side concurrent updates

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 11 | Anniversary balance bump mid-flight | E2E + reconciliation | [e2e.spec.ts](../apps/service/src/api/e2e.spec.ts) · [batch-reconciliation.spec.ts](../apps/service/src/infrastructure/reconciliation/batch-reconciliation.spec.ts) | sustained-outage walk |
| 12 | Year-start refresh thundering herd → batch handles | Reconciliation | [batch-reconciliation.spec.ts](../apps/service/src/infrastructure/reconciliation/batch-reconciliation.spec.ts) | inspected/applied/skipped accounting |
| 13 | Retro correction drops balance below holds → UNDER_HOLD_DEFICIT | Balance | [balance.service.spec.ts](../apps/service/src/domain/balance/balance.service.spec.ts) | applyHcmUpdate deficit branch |

## 14-18 — State machine

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 14 | Approve a non-PENDING_APPROVAL → STATE_TRANSITION_NOT_ALLOWED | State machine | [request-state-machine.spec.ts](../apps/service/src/domain/request/request-state-machine.spec.ts) | full illegal-transition matrix |
| 15 | Cancel a TAKEN → TERMINAL_STATE_REACHED | Request service | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | terminal-cancel test |
| 16 | Self-approval → rejected at boundary | Request service | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | self-approval guard |
| 17 | Double-approval same key, same input → returns prior response | Idempotency | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) · [idempotency.service.spec.ts](../apps/service/src/domain/idempotency/idempotency.service.spec.ts) | replay tests |
| 18 | Double-approval same key, different input → conflict | Idempotency | [idempotency.service.spec.ts](../apps/service/src/domain/idempotency/idempotency.service.spec.ts) | hash-mismatch test |

## 19-25 — Location transfer

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 19 | Request submitted for date after known transfer | Employment | [employment.service.spec.ts](../apps/service/src/domain/employment/employment.service.spec.ts) | locationAt(date) tests |
| 20 | Transfer arrives while request pending → NEEDS_REVALIDATION | Employment | [employment.service.spec.ts](../apps/service/src/domain/employment/employment.service.spec.ts) | period-history tests |
| 21 | Request spans transfer date → REQUEST_SPANS_LOCATION_TRANSFER | Request | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | create with spanning dates |
| 22 | Transfer to incompatible location → LEAVE_TYPE_NOT_AVAILABLE_AT_NEW_LOCATION | LeaveType | [leave-type-availability.service.spec.ts](../apps/service/src/domain/leave-type-availability/leave-type-availability.service.spec.ts) | location-pair tests |
| 23 | Withdrawn transfer → request reverts | Employment | [employment.service.spec.ts](../apps/service/src/domain/employment/employment.service.spec.ts) | retraction tests |
| 24 | Approved request unaffected by post-approval transfer | Employment | [employment.store.spec.ts](../apps/service/src/domain/employment/employment.store.spec.ts) | immutable post-approval |
| 25 | HCM-driven reattribution via paired events | Inbox | [inbox-processor.spec.ts](../apps/service/src/infrastructure/inbox/inbox-processor.spec.ts) | EMPLOYMENT_CHANGED handling |

## 26-31 — Inbound webhooks

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 26 | Out-of-order webhooks → discarded by version check | Inbound adversarial | [webhook-adversarial.spec.ts](../apps/service/test/inbound-adversarial/webhook-adversarial.spec.ts) | T-IN-18 |
| 27 | Duplicate webhook → deduplicated | Inbound adversarial | [webhook-adversarial.spec.ts](../apps/service/test/inbound-adversarial/webhook-adversarial.spec.ts) | T-IN-10, T-IN-17, T-IN-22 |
| 28 | Webhook for unknown employee → triggers bootstrap if EMPLOYEE_CREATED | Bootstrap | [employee-bootstrap.service.spec.ts](../apps/service/src/domain/employee-bootstrap/employee-bootstrap.service.spec.ts) | webhook path |
| 29 | Malformed webhook → 400, logged | Webhook | [webhook.controller.spec.ts](../apps/service/src/infrastructure/inbox/webhook.controller.spec.ts) · [webhook-adversarial.spec.ts](../apps/service/test/inbound-adversarial/webhook-adversarial.spec.ts) | malformed-envelope, T-IN-14, T-IN-15, T-IN-21 |
| 30 | Bad signature → 401, logged | Webhook | [webhook.controller.spec.ts](../apps/service/src/infrastructure/inbox/webhook.controller.spec.ts) · [webhook-adversarial.spec.ts](../apps/service/test/inbound-adversarial/webhook-adversarial.spec.ts) | T-IN-19, T-IN-20 |
| 31 | Webhook flood → inbox absorbs; processor drains | Inbound adversarial | [webhook-adversarial.spec.ts](../apps/service/test/inbound-adversarial/webhook-adversarial.spec.ts) | T-IN-16, T-IN-17 |

## 32-36 — Reconciliation

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 32 | Batch + realtime racing → version check protects | Reconciliation | [batch-reconciliation.spec.ts](../apps/service/src/infrastructure/reconciliation/batch-reconciliation.spec.ts) | apply-newer-only test |
| 33 | Reconciler finds drift → applies HCM truth | Reconciliation | [batch-reconciliation.spec.ts](../apps/service/src/infrastructure/reconciliation/batch-reconciliation.spec.ts) · [drift-sweep.spec.ts](../apps/service/src/infrastructure/reconciliation/drift-sweep.spec.ts) | tick + sweep tests |
| 34 | Reconciler running with outbox in flight → no conflict | Reconciliation | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | lease-prevents-concurrent test |
| 35 | New leave type in batch → LeaveTypeAvailability created | LeaveType | [leave-type-availability.store.spec.ts](../apps/service/src/domain/leave-type-availability/leave-type-availability.store.spec.ts) | upsert tests |
| 36 | Leave type disappears → marked inactive | LeaveType | [leave-type-availability.service.spec.ts](../apps/service/src/domain/leave-type-availability/leave-type-availability.service.spec.ts) | isActive transitions |

## 37-41 — Data model

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 37 | Negative balance within UX tolerance → allowed | Property-based | [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | T-PROP-03 (hold non-negativity) |
| 38 | Negative balance beyond tolerance → HCM dispositive | Balance | [balance.service.spec.ts](../apps/service/src/domain/balance/balance.service.spec.ts) | applyHcmUpdate tests |
| 39 | Decimal precision mismatch → input rejected | Idempotency | [canonical-serializer.spec.ts](../libs/decimal-scalar/src/canonical-serializer.spec.ts) · [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | T-PROP-01 |
| 40 | Units = 0 → INVALID_DATES | Request | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | parseAndValidateInput |
| 41 | End < start → INVALID_DATES | Request | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | parseAndValidateInput |

## 42-45 — Cancellation

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 42 | Cancel PENDING_APPROVAL → local-only | Request | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | pending-cancel path |
| 43 | Cancel APPROVED with HCM available → standard saga | Request | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | approved-cancel path |
| 44 | Cancel APPROVED during HCM outage → provisional cancellation | Request + reconciler | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) · [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | cancelProvisionally + drain |
| 45 | Cancel of already-cancelled → idempotent return | Idempotency | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | replay tests |

## 46-48 — Crash recovery

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 46 | Crash after DB, before outbox dispatch → outbox persists | Outbox | [outbox-worker.spec.ts](../apps/service/src/infrastructure/outbox/outbox-worker.spec.ts) | resume tests |
| 47 | Crash during HCM call → idempotency key replays | Reconciler | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | history-query short-circuit |
| 48 | Crash during reconciliation → idempotent restart | Reconciler | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | TERMINAL skip on re-tick |

## 49-57 — Break-glass

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 49 | Break-glass with HCM available → threshold-not-met | Break-glass | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) · [break-glass.authorizer.spec.ts](../apps/service/src/domain/break-glass/break-glass.authorizer.spec.ts) | HCM_HEALTHY branch |
| 50 | Outage < threshold → BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET | Break-glass | [break-glass.authorizer.spec.ts](../apps/service/src/domain/break-glass/break-glass.authorizer.spec.ts) | OUTAGE_THRESHOLD_NOT_MET |
| 51 | Threshold met, role missing → BREAK_GLASS_NOT_AUTHORIZED | Break-glass | [break-glass.authorizer.spec.ts](../apps/service/src/domain/break-glass/break-glass.authorizer.spec.ts) | NOT_AUTHORIZED |
| 52 | Break-glass success → PROVISIONALLY_APPROVED with full audit | Request | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | approveProvisionally happy |
| 53 | Break-glass → HCM recovers → APPROVED | Reconciler + E2E | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) · [e2e.spec.ts](../apps/service/src/api/e2e.spec.ts) | happy reconcile |
| 54 | Break-glass → HCM recovers → ESCALATED_TO_HR | Reconciler | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | rejected reconcile |
| 55 | Leave taken before HCM recovers, HCM accepts → TAKEN clean | Reconciler | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | §9.5.5 accept |
| 56 | Leave taken before HCM recovers, HCM rejects → TAKEN+hrReviewFlag | Reconciler + HR queue | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) · [hr-review-queue.service.spec.ts](../apps/service/src/domain/hr-review-queue/hr-review-queue.service.spec.ts) | §9.5.5 reject |
| 57 | Break-glass + cancel before reconciliation → both NO_OP | Reconciler | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | pair-coalescing |

## 58-60 — Provisional cancellation

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 58 | Provisional cancellation of APPROVED → CANCELLATION_PENDING → CANCELLED | Reconciler | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | CANCELLATION saga drain |
| 59 | Provisional cancellation, HCM rejects credit | Reconciler | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | escalation branch |
| 60 | Cancellation-pending alert after threshold | HR queue | [hr-review-queue.service.spec.ts](../apps/service/src/domain/hr-review-queue/hr-review-queue.service.spec.ts) | CANCELLATION_STUCK category |

## 61-64 — Bootstrap

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 61 | New employee submits, webhook hasn't arrived → lazy pull | Bootstrap | [employee-bootstrap.service.spec.ts](../apps/service/src/domain/employee-bootstrap/employee-bootstrap.service.spec.ts) | lazy path |
| 62 | New employee, HCM unavailable → EMPLOYEE_NOT_BOOTSTRAPPED | Bootstrap | [employee-bootstrap.service.spec.ts](../apps/service/src/domain/employee-bootstrap/employee-bootstrap.service.spec.ts) | HCM-down path |
| 63 | New employee in batch dump only → bootstrapped via batch | Bootstrap | [employee-bootstrap.service.spec.ts](../apps/service/src/domain/employee-bootstrap/employee-bootstrap.service.spec.ts) | batch path |
| 64 | Webhook race during lazy pull → idempotent | Bootstrap | [employee.store.spec.ts](../apps/service/src/domain/employee-bootstrap/employee.store.spec.ts) · [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | upsert + T-PROP-02 |

## 65-67 — Canonicalization

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 65 | Field-order independence | Canonicalization | [canonical-serializer.spec.ts](../libs/decimal-scalar/src/canonical-serializer.spec.ts) · [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | T-PROP-01 (×1000) |
| 66 | Decimal-format equivalence | Canonicalization | [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | T-PROP-01 decimal block |
| 67 | Unicode NFC vs NFD | Canonicalization | [canonical-serializer.spec.ts](../libs/decimal-scalar/src/canonical-serializer.spec.ts) | NFC test |

## 68-74 — Provisional reconciler exactly-once

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 68 | Pre-flight history reveals matching txn → short-circuit | Layer 21 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | history-query short-circuits |
| 69 | Pre-flight history reveals mismatched delta → REJECTED_ESCALATED | Layer 21 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | history-mismatch test |
| 70 | Pre-flight history empty → call HCM with action.id key | Layer 21 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | happy path |
| 71 | Crash after HISTORY_QUERIED, before HCM call → repeats query | Layer 21 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | idempotency replay |
| 72 | Crash after HCM call, before OUTCOME → resume via history | Layer 21 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | replay (history short-circuits) |
| 73 | Concurrent ticks → lease prevents both | Layer 21 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) · [reconciler-lease.store.spec.ts](../apps/service/src/infrastructure/reconciliation/reconciler-lease.store.spec.ts) | lease tests |
| 74 | Step insert failure → reconciler aborts safely | Layer 21 | [reconciliation-step.store.spec.ts](../apps/service/src/infrastructure/reconciliation/reconciliation-step.store.spec.ts) | append-only enforcement |

## 75-77 — Pair-coalescing

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 75 | Approval + provisional cancellation, same outage → both NO_OP | Layer 23 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | pair-coalesce tests · T-PROP-08 |
| 76 | Two provisional cancellations → second idempotent | Property-based | [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | T-PROP-08 |
| 77 | Two break-glass approvals → state guard rejects second | State machine | [request-state-machine.spec.ts](../apps/service/src/domain/request/request-state-machine.spec.ts) | illegal-from-PROVISIONALLY_APPROVED |

## 78 — Cancellation acknowledgment contract

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 78 | Cancel APPROVED during outage WITHOUT flag → CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT | Layer 25 | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | cancelProvisionally without flag |

## 79-80 — Rev 3.1

| # | Case | Layer | File | Test |
| --- | --- | --- | --- | --- |
| 79 | Employee deleted at HCM between break-glass and reconciliation | Layer 21 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | EMPLOYEE_NOT_FOUND during history |
| 80 | History-query window exclusion | Layer 21 | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) | window math (configurable) |

---

## Layer roll-up

| Layer | Spec file(s) | Test count (post-build-out) |
| --- | --- | --- |
| 1 — Unit | ~30 co-located `.spec.ts` files | ~340 |
| 2 — Integration | [api.spec.ts](../apps/service/src/api/api.spec.ts) | 10 |
| 3 — End-to-End | [e2e.spec.ts](../apps/service/src/api/e2e.spec.ts) | 1 sustained-outage walk |
| 4 — Property-based | [properties.spec.ts](../apps/service/test/property/properties.spec.ts) | 14 properties × 1000 runs each |
| 5 — Outbound failure injection | [outbound-failure-injection.spec.ts](../apps/service/test/failure-injection/outbound-failure-injection.spec.ts) | 14 (T-FI-01..10) |
| 6 — Inbound adversarial | [webhook.controller.spec.ts](../apps/service/src/infrastructure/inbox/webhook.controller.spec.ts) + [webhook-adversarial.spec.ts](../apps/service/test/inbound-adversarial/webhook-adversarial.spec.ts) | 20 (7 + 13 T-IN-*) |
| 7 — Reconciliation | batch / drift / point-read / provisional spec files | ~70 |
| 8 — Contract (HCM port) | [libs/hcm-port/src/*.spec.ts](../libs/hcm-port/src/) | 30 |
| 9 — Mutation (Stryker) | [stryker.config.json](../stryker.config.json) — on push to main + nightly via [`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml) | 23 mutated files spanning the 17 critical modules · `npm run test:mutation` · `break: 75` overall · 75.38% current |
| 10 — Configuration | [env-schema.spec.ts](../apps/service/src/infrastructure/config/env-schema.spec.ts) | 5 |
| 11 — State machine | [request-state-machine.spec.ts](../apps/service/src/domain/request/request-state-machine.spec.ts) | 6 + T-PROP-04 |
| 12 — Error taxonomy | [error-code.spec.ts](../libs/domain-types/src/error-code.spec.ts) + [domain-error.spec.ts](../libs/domain-types/src/domain-error.spec.ts) | 12 |
| 13 — Location transfer | [employment.*.spec.ts](../apps/service/src/domain/employment/) | 18 |
| 14 — LeaveTypeAvailability | [leave-type-availability.*.spec.ts](../apps/service/src/domain/leave-type-availability/) | 14 |
| 15 — Idempotency + canonicalization | [canonical-serializer.spec.ts](../libs/decimal-scalar/src/canonical-serializer.spec.ts) + [idempotency.service.spec.ts](../apps/service/src/domain/idempotency/idempotency.service.spec.ts) + T-PROP-01/02 | 30+ |
| 16 — Crash recovery | covered inside Layer 21 + outbox-worker | ~12 |
| 17 — Mock HCM internal | [api.integration.spec.ts](../apps/mock-hcm/test/api.integration.spec.ts) + Mock HCM store specs | 20 |
| 18 — Break-glass | [break-glass.authorizer.spec.ts](../apps/service/src/domain/break-glass/break-glass.authorizer.spec.ts) + [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | ~25 |
| 19 — Bootstrap | [employee-bootstrap.service.spec.ts](../apps/service/src/domain/employee-bootstrap/employee-bootstrap.service.spec.ts) + [employee.store.spec.ts](../apps/service/src/domain/employee-bootstrap/employee.store.spec.ts) | 20 |
| 20 — Point-read jitter / coalescing | [point-read-scheduler.spec.ts](../apps/service/src/infrastructure/reconciliation/point-read-scheduler.spec.ts) | 8 |
| 21 — Provisional reconciler exactly-once | [provisional-reconciler.spec.ts](../apps/service/src/infrastructure/reconciliation/provisional-reconciler.spec.ts) + [reconciler-lease.store.spec.ts](../apps/service/src/infrastructure/reconciliation/reconciler-lease.store.spec.ts) + [reconciliation-step.store.spec.ts](../apps/service/src/infrastructure/reconciliation/reconciliation-step.store.spec.ts) | 28+ |
| 22 — HR Review Queue | [hr-review-queue.service.spec.ts](../apps/service/src/domain/hr-review-queue/hr-review-queue.service.spec.ts) | 16 |
| 23 — Pair-coalescing | covered inside Layer 21 + T-PROP-08 | 3 + property |
| 24 — MockHcmTestHarness self-tests | [mock-hcm-test-harness.spec.ts](../apps/service/test/helpers/mock-hcm-test-harness.spec.ts) | 29 (T-HRN-*) |
| 25 — Cancellation acknowledgment contract | [request.service.spec.ts](../apps/service/src/domain/request/request.service.spec.ts) | 2 (T-CACK-* equivalents) |

**Total:** 785 named tests across 54 test suites. Property-based runs amplify to ≥14,000 randomized scenarios per `npm test`. All 80 TRD §15 cases are mapped.
