# `@time-off/mock-hcm`

Mock HCM partner — a separate NestJS application with its own SQLite store, used by the service's tests and local-dev runs. See the [root README](../../README.md) for context.

## Run

```bash
npm --workspace @time-off/mock-hcm run start:dev
# default port 4000
```

The mock listens on `:PORT` (default `4000`). It implements TRD §17.2's HTTP surface — every endpoint a real HCM adapter would call against a vendor.

## HTTP surface (TRD §17.2)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/balances/:employeeId/:locationId/:leaveTypeId` | Single balance read |
| `POST` | `/balances/reserve` | Idempotent debit (header `Idempotency-Key`) |
| `POST` | `/balances/release` | Idempotent credit |
| `GET` | `/balances/batch` | NDJSON corpus stream |
| `GET` | `/employment/:employeeId` | Employment timeline |
| `GET` | `/leaveTypes/:locationId` | Leave-type availability at a location |
| `GET` | `/employees/:employeeId` | Single employee (for lazy bootstrap) |
| `POST` | `/transactions/query` | Pre-flight history lookup for the provisional reconciler (ADR-018) |
| `POST` | `/admin/*` | Test seams — see below |
| `GET` | `/admin/state` | Full inspectable state |

### Admin endpoints (NOT part of the public HCM contract)

```
POST /admin/setBalance               Seed or replace a balance row
POST /admin/setEmployment            Seed or replace an employment period
POST /admin/setLeaveTypeAvailability Seed leave-type validity
POST /admin/setEmployee              Insert/upsert an employee (no webhook)
POST /admin/deleteEmployee           Remove an employee (TRD §9.5.3 [3.1e] / Q.ν)
POST /admin/setTransaction           Plant a synthetic transaction for queryTransactions tests
POST /admin/reset                    Clear every table (test isolation)
```

These are accessed only via the [`MockHcmTestHarness`](../service/test/helpers/mock-hcm-test-harness.ts) — direct admin calls from test files are forbidden by ADR-020.

## Persistence

The mock has its own SQLite file (default `:memory:` in tests; `./mock-hcm.sqlite` recommended for local dev). State persists across mock restarts so crash-recovery tests can confirm HCM state across a service restart.

## Layout

```
src/
  main.ts                Bootstrap; binds to :PORT.
  app.module.ts          Composes API + admin + persistence.
  api/                   Public HCM contract: balances, employment, leave-types, employees, transactions.
  admin/                 Test-driving endpoints (see above).
  common/                Shared utilities (response shaping, signing helpers).
  persistence/           SQLite migrations + repositories for the mock's internal tables.
```

## Not yet implemented

The TRD §17.3 specifies adversarial modes (`flaky`, `silent_no_op`, `stale_version`, `slow`, …) and reachability toggling. The mock currently runs only in honest `normal` mode; the harness stubs for those modes throw `MockHcmHarnessError` with a clear "not yet implemented" message. Webhook scheduling (`scheduleBalanceUpdate`, etc.) is similarly stubbed.
