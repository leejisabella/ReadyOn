# ReadyOn Time-Off Microservice

A NestJS microservice that manages employee time-off requests on top of a remote Human Capital Management (HCM) system. HCM is the canonical store of truth for balances, employment, and leave-type availability; this service projects HCM state locally, orchestrates the request lifecycle, defends against silent HCM failures, and provides a break-glass mechanism for continued operation during HCM outages.

## Status

Revision 3.1 implementation in progress. The design is settled; see `docs/`. This codebase is being built in vertical slices per `docs/00_Cover_and_Reasoning.md` §8.

## Stack

- **NestJS 10** (TypeScript 5.3+, strict mode)
- **GraphQL** via Apollo, code-first
- **SQLite** via `better-sqlite3` (WAL mode)
- **`decimal.js`** for all monetary/unit arithmetic
- **`zod`** for schema validation at every trust boundary
- **Jest** + **`fast-check`** (property-based) + **Stryker** (mutation) for tests

## Layout

```
apps/
  service/       NestJS service
  mock-hcm/      Mock HCM partner (separate process, own SQLite)
libs/
  domain-types/  Shared DTOs, enums, ErrorCode, RequestState
  hcm-port/      HcmPort interface + zod schemas (incl. queryTransactions)
  decimal-scalar/ GraphQL Decimal scalar + canonicalization helpers
docs/
  00_Cover_and_Reasoning.md       Design narrative
  01_TRD.md                       Technical Requirements Document
  02_Assumptions_and_Decisions.md ADRs
  03_Test_Plan.md                 Test plan + traceability matrix
  04_Module_Plan.md               Code organization
  operations/                     Runbooks
```

## Quickstart

```bash
npm install
npm test               # runs all test layers; passes with zero tests during slice 1
npm run typecheck      # tsc -b --noEmit
```

To run the apps once their slices are implemented:

```bash
npm run start:service
npm run start:mock-hcm
# or, both at once:
npm run start:all
```

## Documentation

- **What we're building and why:** [`docs/00_Cover_and_Reasoning.md`](docs/00_Cover_and_Reasoning.md)
- **Authoritative specification:** [`docs/01_TRD.md`](docs/01_TRD.md)
- **Why each major decision:** [`docs/02_Assumptions_and_Decisions.md`](docs/02_Assumptions_and_Decisions.md)
- **What the tests prove:** [`docs/03_Test_Plan.md`](docs/03_Test_Plan.md)
- **Where code lives:** [`docs/04_Module_Plan.md`](docs/04_Module_Plan.md)

## Tests

The test suite is composed of 25 layers, each guarding a specific class of regression. Coverage targets: ≥90% statement, ≥85% branch overall; ≥75% mutation kill rate on critical modules. See [`docs/03_Test_Plan.md`](docs/03_Test_Plan.md).
