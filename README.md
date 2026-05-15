# ReadyOn Time-Off Microservice

A production-shaped NestJS service that manages employee time-off requests on top of a remote HCM (Human Capital Management) system. HCM is the canonical store of truth for balances; this service projects HCM state locally, orchestrates the request lifecycle, defends against silent HCM failures, and supports continued operation during HCM outages via a break-glass mechanism that reconciles exactly-once when HCM recovers.

## Stack

- **NestJS 10** (TypeScript 5.3+, strict mode)
- **Apollo Server 4** with code-first GraphQL
- **SQLite** via `better-sqlite3` (WAL mode, prepared statements, no ORM)
- **`decimal.js`** for every monetary/unit value
- **`zod`** for schema validation at every trust boundary (HCM responses, env config, GraphQL inputs)
- **Jest 29** for unit + integration + end-to-end tests

## Layout

```
apps/
  service/                   The Time-Off service (NestJS + GraphQL + SQLite)
    src/
      api/                   GraphQL layer: scalars, types, inputs, resolvers, auth decorator, error filter
      domain/                Business logic: request saga, balance, employment, leave-type availability,
                             provisional-action log, break-glass authorizer, HR review queue, idempotency,
                             employee bootstrap
      infrastructure/        Cross-cutting: config (env-schema + Zod), HCM adapter + health monitor,
                             inbox/outbox workers, reconciliation (drift sweep, batch, provisional drainer),
                             observability (audit events, correlation context, metrics), persistence
                             (DB module, migrations, append-only triggers)
    test/                    Test helpers (notably MockHcmTestHarness)
  mock-hcm/                  Mock HCM partner — separate NestJS app with its own SQLite
libs/
  domain-types/              Shared DomainError, ErrorCode taxonomy
  hcm-port/                  Versioned HCM contract: HcmPort interface, error classes, zod schemas
  decimal-scalar/            Decimal parser + canonical-input serializer (for idempotency hashing)
docs/
  00_Cover_and_Reasoning.md      Design narrative — why each major piece exists
  01_TRD.md                      Authoritative spec
  02_Assumptions_and_Decisions.md  ADRs
  03_Test_Plan.md                Test plan + traceability matrix
  04_Module_Plan.md              Module hierarchy + interface surfaces
  operations/                    Operator runbooks (see below)
```

## Quickstart

```bash
npm install
npm run typecheck                  # tsc -b (no emit)
npm test                           # full Jest suite — every layer, ~3s
```

Run the apps locally:

```bash
npm run start:mock-hcm             # mock HCM on :4000
npm run start:service              # service on :3000 (/graphql)
# or both at once:
npm run start:all
```

Required env when running the service (other knobs have defaults; see [the config surface](#configuration)):

```bash
HCM_BASE_URL=http://localhost:4000  npm run start:service
```

Open `http://localhost:3000/graphql` to explore the schema.

## Architecture

```
                  GraphQL / HTTP boundary
                            │
            ┌───────────────┼─────────────────┐
            ▼                                 ▼
  ┌───────────────────┐               ┌──────────────────┐
  │  Resolvers        │               │  AuthGuard /     │
  │  (api/resolvers)  │               │  DomainErrorFilter│
  └─────────┬─────────┘               └──────────────────┘
            │
            ▼
  ┌───────────────────────────────────────────────────────┐
  │  Domain services (saga, balance, employment, …)       │
  │  • RequestService — every state transition            │
  │  • BalanceService — three hold buckets                │
  │  • BreakGlassAuthorizer — role + outage gate          │
  │  • HrReviewQueueService — 3-category projection       │
  └─────────┬───────────────────────────────────┬─────────┘
            │                                   │
            ▼                                   ▼
  ┌───────────────────┐                ┌─────────────────────┐
  │  SQLite (WAL)     │                │  HCM port (typed)   │
  │  • time_off_request                │  • reserveBalance   │
  │  • balance                         │  • releaseBalance   │
  │  • provisional_action (append-only)│  • queryTransactions│
  │  • reconciliation_step (append-only)│ • fetchBalance     │
  │  • audit_event                     └──────────┬──────────┘
  │  • outbox / inbox                             │
  │  • idempotency_key                            ▼
  │  • reconciler_lease                ┌─────────────────────┐
  └─────────┬─────────┐                │  Mock HCM (separate)│
            │         │                │  • own SQLite       │
            ▼         ▼                └─────────────────────┘
   Workers:                                       ▲
   • Outbox worker — drains pending HCM calls     │
   • Inbox processor — applies webhook events     │
   • Provisional reconciler — drains break-glass  │
     actions on HCM recovery (TRD §9.5.3) ────────┘
   • Drift sweep — schedules point-reads for stale balances
   • Batch reconciliation — daily HCM corpus pull
```

The full lifecycle of a single request can take one of three paths:

1. **Normal**: `create` → `approve` (HCM debit) → eventually `cancel` or `TAKEN`.
2. **Break-glass (HCM unavailable)**: `create` → `approveProvisionally` (logs `ProvisionalAction`) → HCM recovers → provisional reconciler drains → `APPROVED` (or `ESCALATED_TO_HR` if HCM rejects).
3. **Provisional cancellation (HCM unavailable, request already approved)**: `cancel` with `acknowledgedHcmUnavailable: true` → `CANCELLATION_PENDING` → reconciler drains → `CANCELLED`.

## Configuration

The service reads `process.env` once at startup via [`loadConfig`](apps/service/src/infrastructure/config/env-schema.ts). Required:

| Env | Description |
| --- | --- |
| `HCM_BASE_URL` | URL of the HCM service (or Mock HCM in dev). |

Optional (with TRD §16 defaults):

| Env | Default | Maps to |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `DB_PATH` | `./time-off.db` | SQLite file location |
| `HCM_TIMEOUT_MS` | `5000` | HCM per-call timeout |
| `HCM_UNHEALTHY_AFTER_FAILURES` | `3` | Consecutive failures before health monitor flips |
| `HCM_HEALTHY_AFTER_MS` | `60000` | Recovery-window duration |
| `BREAK_GLASS_MIN_OUTAGE_MS` | `60000` | Outage duration before break-glass is allowed |
| `BREAK_GLASS_REQUIRE_ROLE` | `break_glass_approver` | Role required to invoke break-glass |
| `RECONCILER_HISTORY_QUERY_WINDOW_MS` | 24h | Pre-flight history query window |
| `RECONCILER_STALE_AFTER_MS` | 4h | Stale-provisional-action alert threshold |
| `RECONCILER_LEASE_TTL_MS` | `60000` | Advisory-lock TTL |
| `RECONCILIATION_STALE_BALANCE_THRESHOLD_MS` | 5min | Drift-sweep staleness threshold |
| `CANCELLATION_PENDING_ALERT_THRESHOLD_MS` | 1h | HR-review `CANCELLATION_STUCK` threshold |

Invalid config aborts boot with a readable error listing every failing field.

## Auth boundary

The service trusts gateway-signed headers per TRD §15:

- `x-actor-id` — caller's identity (required)
- `x-actor-role` — one of `employee`, `manager`, `break_glass_approver`, `hr_admin` (required)
- `x-correlation-id` — propagated through every audit row and structured log line (optional; a UUID is generated when absent)

Mutations whose schema includes `approverId` / `actorId` validate the argument against the gateway-asserted identity (defense in depth — see [`assertActorMatches`](apps/service/src/api/resolvers/time-off-request.resolver.ts)).

## Tests

The Jest suite covers every layer:

```bash
npm test                       # full suite — 54 suites, 785 tests, ~3s
npm run test:coverage          # same + coverage report (CI gate)
npm run test:mutation          # Stryker mutation suite, ~23 min
```

Notable groupings:

- **Unit**: every domain service + store has a focused spec under the same directory.
- **Integration**: GraphQL through Apollo + in-process `fetch` in [`api.spec.ts`](apps/service/src/api/api.spec.ts).
- **End-to-end**: a single sustained-outage walk in [`e2e.spec.ts`](apps/service/src/api/e2e.spec.ts) — covers create → break-glass → recovery → reconciliation through the GraphQL API.
- **Mock HCM**: standalone tests under `apps/mock-hcm/test/` + harness self-tests under `apps/service/test/helpers/`.
- **Property-based**: `fast-check`, ≥ 1000 runs per property under `apps/service/test/property/`.
- **Failure injection / inbound adversarial**: targeted suites under `apps/service/test/failure-injection/` and `apps/service/test/inbound-adversarial/`.
- **Mutation**: Stryker against 23 mutated files spanning the 17 critical modules; overall kill-rate gate is 75% (current: 75.38%).

Coverage targets per [`docs/03_Test_Plan.md`](docs/03_Test_Plan.md) §30: ≥ 90% statement / ≥ 70% branch overall (actual 94.76% / 81.43%), ≥ 95% statement on critical modules. The CI pipeline runs all stages on every PR via [`.github/workflows/ci.yml`](.github/workflows/ci.yml); mutation testing runs on push to main + nightly via [`.github/workflows/mutation.yml`](.github/workflows/mutation.yml).

## Documentation

- **Design narrative** — [`docs/00_Cover_and_Reasoning.md`](docs/00_Cover_and_Reasoning.md)
- **Authoritative spec** — [`docs/01_TRD.md`](docs/01_TRD.md)
- **Architectural decisions** — [`docs/02_Assumptions_and_Decisions.md`](docs/02_Assumptions_and_Decisions.md)
- **Test plan** — [`docs/03_Test_Plan.md`](docs/03_Test_Plan.md)
- **Module plan** — [`docs/04_Module_Plan.md`](docs/04_Module_Plan.md)

### Operator runbooks

- [`docs/operations/break-glass-runbook.md`](docs/operations/break-glass-runbook.md) — when to invoke, who can, how to review afterward
- [`docs/operations/bootstrap-runbook.md`](docs/operations/bootstrap-runbook.md) — diagnosing employees who fail to appear
- [`docs/operations/reconciliation-runbook.md`](docs/operations/reconciliation-runbook.md) — interpreting drift classifications
- [`docs/operations/provisional-reconciler-runbook.md`](docs/operations/provisional-reconciler-runbook.md) — reading `ReconciliationStep` logs, debugging stuck actions, stale-alert response
- [`docs/operations/hr-review-runbook.md`](docs/operations/hr-review-runbook.md) — workflow for HR users consuming `hrReviewQueue`

## Known gaps

The TRD describes features beyond what the brief required. Each is a documented, deliberate deferral — not an oversight — and each carries a `not yet implemented` marker in the code rather than placeholder behaviour:

| Gap | TRD § | Why deferred |
| --- | --- | --- |
| `ingestHcmEvent` GraphQL mutation | §7.1 | Functionally equivalent HTTP webhook (`POST /webhooks/hcm`) already in place; webhook is the idiomatic HCM-driven path |
| Drift classification on batch reconciliation | §10.2 | Spec requires per-tenant policy data (anniversary, accrual rate, fiscal year) the system doesn't yet load; shipping without it would mis-classify |
| Remaining TRD §16 config knobs (`outbox.*`, `inbox.*`, snapshot retention, policy hints) | §16 | Hardcoded defaults match the spec; env-tunability is YAGNI until ops observes real workloads |

**Full rationale, brief-vs-TRD compliance check, and concrete extension plans for each gap are in [`docs/EXTENSION_ROADMAP.md`](docs/EXTENSION_ROADMAP.md).**

See TRD §19 for the full out-of-scope-but-boundary-defined list and `docs/operations/*-runbook.md` for which gaps each operational scenario routes around.
