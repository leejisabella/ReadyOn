# `@time-off/service`

The Time-Off microservice. NestJS + GraphQL (Apollo) + SQLite. See the [root README](../../README.md) for project-wide context.

## Run

```bash
HCM_BASE_URL=http://localhost:4000 npm --workspace @time-off/service run start:dev
```

The service listens on `:PORT` (default `3000`) with GraphQL at `/graphql`. Schema is generated code-first into `schema.gql` at the project root (or a tmp file in tests).

## Layout

```
src/
  api/                          GraphQL layer
    api.module.ts                 Apollo wiring + global DomainErrorFilter
    auth/                         CurrentActor decorator (gateway headers → ActorContext)
    enums.ts                      GraphQL enums (RequestState, HrReviewCategory, etc.)
    errors/                       DomainError → GraphQLError filter
    inputs/                       Input types (CreateTimeOffRequestInput, ProvisionalActionFilter)
    resolvers/                    One @Resolver per top-level type
    scalars/                      Decimal, DateTime, Date scalars
    types/                        @ObjectType classes — field TS types mirror domain rows
  domain/
    balance/                      Three hold buckets + state derivation
    break-glass/                  Pure authorizer (role + outage gate)
    employee-bootstrap/           Three-path bootstrap: webhook + lazy + batch
    employment/                   Location-history projection
    hr-review-queue/              3-category projection w/ cursor pagination
    idempotency/                  Canonical hash + replay cache
    leave-type-availability/      Leave-type validity projection
    provisional-action/           Append-only event log w/ 5-field allow-list (ADR-022)
    request/                      The saga + state machine
  infrastructure/
    config/                       env → ServiceConfig (Zod schema, fail-fast on misconfig)
    hcm/                          HCM adapter + health monitor + module
    inbox/                        Webhook intake + processor
    observability/                AuditEventStore + CorrelationContext + Metrics
    outbox/                       Pending HCM mutations + worker
    persistence/                  Migrations, DB module, append-only triggers
    reconciliation/               4 cadences:
                                    - PointReadScheduler (after-commit verifier)
                                    - DriftSweep (stale-balance walker)
                                    - BatchReconciliation (daily HCM corpus pull)
                                    - ProvisionalReconciler (break-glass drainer)
test/
  helpers/                        MockHcmTestHarness — single entry point for every mock interaction (ADR-020)
```

## Tests

```bash
npx jest --selectProjects @time-off/service       # service-only
npx jest --testPathPattern "request.service"      # one suite
npx jest --testPathPattern "e2e.spec"             # end-to-end sustained-outage walk
```

Every domain service has a focused `.spec.ts` next to it. The integration tests live alongside:

- [`api/api.spec.ts`](src/api/api.spec.ts) — GraphQL through Apollo + supertest
- [`api/e2e.spec.ts`](src/api/e2e.spec.ts) — the full create → outage → break-glass → recovery → reconciliation walk

## Bootstrapping ground truth

In tests we use [`MockHcmTestHarness`](test/helpers/mock-hcm-test-harness.ts) to seed mock HCM state. In production, the same data arrives via inbox webhooks (`BALANCE_UPDATED`, `EMPLOYMENT_CHANGED`, `LEAVE_TYPE_CHANGED`, `EMPLOYEE_CREATED`) or lazy pull at first touch (TRD §11.3).

## Where the rules live

| Concern | Source file |
| --- | --- |
| Request state transitions | [`request-state-machine.ts`](src/domain/request/request-state-machine.ts) |
| Hold arithmetic | [`hold-accountant.ts`](src/domain/balance/hold-accountant.ts) |
| Idempotency-key hashing | [`canonical-serializer.ts`](../../libs/decimal-scalar/src/canonical-serializer.ts) |
| HCM contract (zod) | [`schemas.ts`](../../libs/hcm-port/src/schemas.ts) |
| Append-only invariants | [`append-only-triggers.ts`](src/infrastructure/persistence/append-only-triggers.ts) |
| Error taxonomy | [`error-code.ts`](../../libs/domain-types/src/error-code.ts) |
| Reconciler algorithm | [`provisional-reconciler.service.ts`](src/infrastructure/reconciliation/provisional-reconciler.service.ts) |
