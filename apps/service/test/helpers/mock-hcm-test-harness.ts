import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MockHcmModule } from '@time-off/mock-hcm';
import Decimal from 'decimal.js';
import {
  MockHcmHarnessAssertionError,
  MockHcmHarnessError,
  type AssertBalanceExpected,
  type AssertTransactionExpected,
  type MockHcmMode,
  type MockHcmSnapshot,
  type MockHcmTestHarnessOptions,
  type MockHcmTransactionRow,
  type ReachabilityState,
  type SeedBalanceInput,
  type SeedEmployeeInput,
  type SeedEmploymentInput,
  type SeedLeaveTypeAvailabilityInput,
  type SeedTransactionInput,
} from './mock-hcm-test-harness.types';

// re-export for tests so a single import suffices
export {
  MockHcmHarnessAssertionError,
  MockHcmHarnessError,
} from './mock-hcm-test-harness.types';
export type {
  AssertBalanceExpected,
  AssertTransactionExpected,
  MockHcmMode,
  MockHcmSnapshot,
  MockHcmTestHarnessOptions,
  MockHcmTransactionRow,
  ReachabilityState,
  SeedBalanceInput,
  SeedEmployeeInput,
  SeedEmploymentInput,
  SeedLeaveTypeAvailabilityInput,
  SeedTransactionInput,
} from './mock-hcm-test-harness.types';

/**
 * Single entry-point that every higher test layer uses to drive the Mock HCM.
 *
 * Lifecycle:
 *  1. `beforeAll`:   `const harness = await MockHcmTestHarness.boot();`
 *  2. `beforeEach`:  `await harness.reset();`
 *  3. test body:     `await harness.seed*` / `await harness.assert*`
 *  4. `afterAll`:    `await harness.shutdown();`
 *
 * Crash-recovery tests skip `reset()` and use `snapshot()` / `restoreSnapshot()`
 * to control persistence deliberately.
 *
 * @invariant Every test interaction with the Mock HCM flows through this
 *   class — ad-hoc admin HTTP calls in test files are forbidden (ADR-020).
 *
 * @ref docs/01_TRD.md §17.6
 * @ref docs/02_Assumptions_and_Decisions.md ADR-020
 * @ref docs/04_Module_Plan.md §5.12
 */
export class MockHcmTestHarness {
  /**
   * Base URL of the running mock. Pass this to adapters/clients under test so
   * they hit the in-process mock instead of a real HCM.
   */
  readonly baseUrl: string;

  private readonly app: INestApplication;

  private constructor(app: INestApplication, baseUrl: string) {
    this.app = app;
    this.baseUrl = baseUrl;
  }

  /**
   * Boot the Mock HCM in-process with a fresh `:memory:` SQLite (overridable
   * via `dbPath`). Returns once the HTTP server is listening on a random port.
   */
  static async boot(opts: MockHcmTestHarnessOptions = {}): Promise<MockHcmTestHarness> {
    const dbPath = opts.dbPath ?? ':memory:';
    const moduleRef = await Test.createTestingModule({
      imports: [MockHcmModule.forRoot({ dbPath })],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    const url = await app.getUrl();
    // `getUrl()` returns `http://[::1]:PORT` on dual-stack hosts; some fetch
    // implementations dislike bracketed IPv6 — normalize to IPv4 loopback.
    const baseUrl = url.replace('[::1]', '127.0.0.1');
    return new MockHcmTestHarness(app, baseUrl);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Drop every domain table and re-migrate. Idempotent. */
  async reset(): Promise<void> {
    await this.request('POST', '/admin/reset');
  }

  /** Close the underlying Nest application; safe to call multiple times. */
  async shutdown(): Promise<void> {
    await this.app.close();
  }

  /** Full snapshot of mock state — usable as the input to `restoreSnapshot`. */
  async snapshot(): Promise<MockHcmSnapshot> {
    return (await this.request('GET', '/admin/state')) as MockHcmSnapshot;
  }

  /** Wipe + reload the entire mock from a snapshot. */
  async restoreSnapshot(snapshot: MockHcmSnapshot): Promise<void> {
    await this.request('POST', '/admin/restoreState', snapshot);
  }

  /** Alias for {@link snapshot} — provided for test readability at assertion sites. */
  async getState(): Promise<MockHcmSnapshot> {
    return this.snapshot();
  }

  // ── Seeding ──────────────────────────────────────────────────────────────

  /** Create an employee record. Idempotent. */
  async seedEmployee(input: SeedEmployeeInput): Promise<void> {
    await this.request('POST', '/admin/createEmployee', { employeeId: input.employeeId });
    for (const e of input.employment ?? []) {
      await this.seedEmployment({
        employeeId: input.employeeId,
        locationId: e.locationId,
        effectiveFrom: e.effectiveFrom,
        ...(e.effectiveTo !== undefined ? { effectiveTo: e.effectiveTo } : {}),
      });
    }
    for (const b of input.balances ?? []) {
      await this.seedBalance({
        employeeId: input.employeeId,
        locationId: b.locationId,
        leaveTypeId: b.leaveTypeId,
        available: b.available,
      });
    }
  }

  /** Add or replace an employment period. Idempotent on (employeeId, effectiveFrom). */
  async seedEmployment(input: SeedEmploymentInput): Promise<void> {
    await this.request('POST', '/admin/setEmployment', {
      employeeId: input.employeeId,
      locationId: input.locationId,
      effectiveFrom: input.effectiveFrom,
      ...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo } : {}),
    });
  }

  /** Add or replace a leave-type availability row. */
  async seedLeaveTypeAvailability(input: SeedLeaveTypeAvailabilityInput): Promise<void> {
    await this.request('POST', '/admin/setLeaveTypeAvailability', {
      locationId: input.locationId,
      leaveTypeId: input.leaveTypeId,
      isActive: input.isActive,
      effectiveFrom: input.effectiveFrom,
      ...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo } : {}),
    });
  }

  /** Set the balance for a (employee, location, leaveType). */
  async seedBalance(input: SeedBalanceInput): Promise<void> {
    await this.request('POST', '/admin/setBalance', {
      employeeId: input.employeeId,
      locationId: input.locationId,
      leaveTypeId: input.leaveTypeId,
      available: asString(input.available),
    });
  }

  /**
   * Plant a synthetic transaction row. Used by Layer 21 to test the
   * `queryTransactions` history-window boundary (T-PR-EX-14).
   */
  async seedTransaction(input: SeedTransactionInput): Promise<void> {
    await this.request('POST', '/admin/setTransaction', {
      transactionId: input.transactionId,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      employeeId: input.employeeId,
      locationId: input.locationId,
      leaveTypeId: input.leaveTypeId,
      deltaApplied: asString(input.deltaApplied),
      newAvailable: asString(input.newAvailable),
      hcmVersion: typeof input.hcmVersion === 'bigint' ? input.hcmVersion.toString() : input.hcmVersion,
      appliedAt: input.appliedAt,
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.rejectionReason !== undefined ? { rejectionReason: input.rejectionReason } : {}),
    });
  }

  /**
   * Remove an employee record. Exists so Layer 21 can exercise the Rev 3.1
   * `EMPLOYEE_NOT_FOUND_AT_HCM` branch of the provisional reconciler (Q.ν).
   */
  async deleteEmployee(employeeId: string): Promise<void> {
    await this.request('POST', '/admin/deleteEmployee', { employeeId });
  }

  // ── Mode + reachability (TRD §17.3) ─────────────────────────────────────

  /**
   * Switch the mock to an adversarial mode (TRD §17.3). Use `forceNextCalls`
   * for deterministic flaky behaviour in tests; `slowLatencyMs` for the
   * `slow` mode.
   */
  async setMode(
    mode: MockHcmMode,
    options: {
      readonly flakyRate?: number;
      readonly slowLatencyMs?: number;
      readonly forceNextCalls?: number;
    } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { mode };
    if (options.flakyRate !== undefined) body.flakyRate = options.flakyRate;
    if (options.slowLatencyMs !== undefined) body.slowLatencyMs = options.slowLatencyMs;
    if (options.forceNextCalls !== undefined) body.forceNextCalls = options.forceNextCalls;
    await this.request('POST', '/admin/setMode', body);
  }

  /** Toggle the mock's reachability (TRD §17.3 — `unreachable` mode). */
  async setReachability(state: ReachabilityState): Promise<void> {
    await this.request('POST', '/admin/setReachability', { state });
  }

  /** Current mode + reachability state (for assertions in self-tests). */
  async getMode(): Promise<{
    readonly mode: MockHcmMode;
    readonly reachability: ReachabilityState;
    readonly flakyRate: number;
    readonly slowLatencyMs: number;
    readonly forceNextCalls: number;
  }> {
    const res = await this.request('GET', '/admin/mode');
    return res as {
      readonly mode: MockHcmMode;
      readonly reachability: ReachabilityState;
      readonly flakyRate: number;
      readonly slowLatencyMs: number;
      readonly forceNextCalls: number;
    };
  }

  // ── Assertions ──────────────────────────────────────────────────────────

  /**
   * Assert that the balance for `(employee, location, leaveType)` exists and
   * matches `expected`. Decimals compared by value (so '10' and '10.00' are
   * equal); `hcmVersion` compared by string-equal.
   *
   * @throws MockHcmHarnessAssertionError on mismatch.
   */
  async assertBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    expected: AssertBalanceExpected,
  ): Promise<void> {
    const state = await this.snapshot();
    const found = state.balances.find(
      (b) =>
        b.employeeId === employeeId &&
        b.locationId === locationId &&
        b.leaveTypeId === leaveTypeId,
    );
    if (!found) {
      throw new MockHcmHarnessAssertionError(
        `expected a balance for (${employeeId}, ${locationId}, ${leaveTypeId}) but found none`,
        { employeeId, locationId, leaveTypeId },
      );
    }
    if (!new Decimal(found.available).equals(new Decimal(expected.available))) {
      throw new MockHcmHarnessAssertionError(`balance.available mismatch`, {
        employeeId,
        locationId,
        leaveTypeId,
        expected: asString(expected.available),
        actual: found.available,
      });
    }
    if (expected.hcmVersion !== undefined) {
      const expectedVersion = expected.hcmVersion.toString();
      if (found.hcmVersion !== expectedVersion) {
        throw new MockHcmHarnessAssertionError(`balance.hcmVersion mismatch`, {
          employeeId,
          locationId,
          leaveTypeId,
          expected: expectedVersion,
          actual: found.hcmVersion,
        });
      }
    }
  }

  /**
   * Assert that a transaction with the given idempotency key exists; verify
   * optional delta / outcome.
   */
  async assertTransactionExists(
    idempotencyKey: string,
    expected: AssertTransactionExpected = {},
  ): Promise<void> {
    const txn = await this.findTransaction(idempotencyKey);
    if (!txn) {
      throw new MockHcmHarnessAssertionError(
        `expected a transaction with idempotencyKey='${idempotencyKey}' but found none`,
        { idempotencyKey },
      );
    }
    if (expected.delta !== undefined) {
      if (!new Decimal(txn.deltaApplied).equals(new Decimal(expected.delta))) {
        throw new MockHcmHarnessAssertionError(`transaction.deltaApplied mismatch`, {
          idempotencyKey,
          expected: asString(expected.delta),
          actual: txn.deltaApplied,
        });
      }
    }
    if (expected.outcome !== undefined && txn.outcome !== expected.outcome) {
      throw new MockHcmHarnessAssertionError(`transaction.outcome mismatch`, {
        idempotencyKey,
        expected: expected.outcome,
        actual: txn.outcome,
      });
    }
  }

  /** Assert no transaction with the given idempotency key exists. */
  async assertTransactionDoesNotExist(idempotencyKey: string): Promise<void> {
    const txn = await this.findTransaction(idempotencyKey);
    if (txn) {
      throw new MockHcmHarnessAssertionError(
        `expected no transaction with idempotencyKey='${idempotencyKey}'`,
        { idempotencyKey, transactionId: txn.transactionId },
      );
    }
  }

  /** Return every transaction recorded by the mock (any outcome). */
  async listTransactions(): Promise<ReadonlyArray<MockHcmTransactionRow>> {
    return (await this.snapshot()).transactions;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async findTransaction(
    idempotencyKey: string,
  ): Promise<MockHcmTransactionRow | undefined> {
    const state = await this.snapshot();
    return state.transactions.find((t) => t.idempotencyKey === idempotencyKey);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new MockHcmHarnessError(`network error on ${method} ${path}`, err);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!response.ok) {
      throw new MockHcmHarnessError(`${method} ${path} → ${response.status}: ${text}`);
    }
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  }
}

function asString(value: Decimal | string): string {
  return typeof value === 'string' ? value : value.toFixed();
}
