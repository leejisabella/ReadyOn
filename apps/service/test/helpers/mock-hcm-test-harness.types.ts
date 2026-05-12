import type Decimal from 'decimal.js';

/**
 * Types consumed by {@link MockHcmTestHarness}. Decoupled from the harness
 * class so test files can refer to them without pulling the implementation
 * (and its `@nestjs/testing` import) into their type graph.
 *
 * @ref docs/01_TRD.md §17.6
 * @ref docs/04_Module_Plan.md §5.12
 */

// ─── Boot ────────────────────────────────────────────────────────────────────

export interface MockHcmTestHarnessOptions {
  /** SQLite path. Defaults to `:memory:` for hermetic tests. */
  readonly dbPath?: string;
}

// ─── Mode + reachability (TRD §17.3 — not yet implemented in the mock) ────

export type MockHcmMode =
  | 'normal'
  | 'flaky'
  | 'silent_no_op'
  | 'wrong_delta'
  | 'missing_confirmation'
  | 'stale_version'
  | 'malformed'
  | 'slow'
  | 'version_skew'
  | 'unreachable';

export type ReachabilityState =
  | 'on'
  | 'off'
  | { readonly mode: 'flaky'; readonly failureRate: number };

// ─── Snapshot rows (mirror of GET /admin/state) ──────────────────────────────

export type TransactionOutcome = 'ACCEPTED' | 'REJECTED';

export interface MockHcmEmployeeRow {
  readonly employeeId: string;
  readonly hcmVersion: string;
  readonly createdAt: string;
}

export interface MockHcmEmploymentRow {
  readonly employeeId: string;
  readonly locationId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly hcmVersion: string;
}

export interface MockHcmLeaveTypeRow {
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly isActive: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly hcmVersion: string;
}

export interface MockHcmBalanceRow {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly available: string;
  readonly hcmVersion: string;
  readonly appliedAt: string;
}

export interface MockHcmTransactionRow {
  readonly transactionId: string;
  readonly idempotencyKey: string | null;
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly deltaApplied: string;
  readonly newAvailable: string;
  readonly hcmVersion: string;
  readonly appliedAt: string;
  readonly outcome: TransactionOutcome;
  readonly rejectionReason: string | null;
}

export interface MockHcmSnapshot {
  readonly currentHcmVersion: string;
  readonly employees: ReadonlyArray<MockHcmEmployeeRow>;
  readonly employment: ReadonlyArray<MockHcmEmploymentRow>;
  readonly leaveTypes: ReadonlyArray<MockHcmLeaveTypeRow>;
  readonly balances: ReadonlyArray<MockHcmBalanceRow>;
  readonly transactions: ReadonlyArray<MockHcmTransactionRow>;
}

// ─── Seed inputs ─────────────────────────────────────────────────────────────

export interface SeedEmployeeInput {
  readonly employeeId: string;
  readonly employment?: ReadonlyArray<{
    readonly locationId: string;
    readonly effectiveFrom: string;
    readonly effectiveTo?: string | null;
  }>;
  readonly balances?: ReadonlyArray<{
    readonly locationId: string;
    readonly leaveTypeId: string;
    readonly available: Decimal | string;
  }>;
}

export interface SeedEmploymentInput {
  readonly employeeId: string;
  readonly locationId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
}

export interface SeedLeaveTypeAvailabilityInput {
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly isActive: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
}

export interface SeedBalanceInput {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly available: Decimal | string;
}

export interface SeedTransactionInput {
  readonly transactionId: string;
  readonly idempotencyKey?: string | null;
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly deltaApplied: Decimal | string;
  readonly newAvailable: Decimal | string;
  readonly hcmVersion: bigint | string;
  readonly appliedAt: string;
  readonly outcome?: TransactionOutcome;
  readonly rejectionReason?: string | null;
}

// ─── Assertion expectations ──────────────────────────────────────────────────

export interface AssertBalanceExpected {
  readonly available: Decimal | string;
  readonly hcmVersion?: bigint | string;
}

export interface AssertTransactionExpected {
  readonly delta?: Decimal | string;
  readonly outcome?: TransactionOutcome;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when a harness assertion (e.g., `assertBalance`) fails. */
export class MockHcmHarnessAssertionError extends Error {
  readonly context?: Readonly<Record<string, unknown>>;
  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'MockHcmHarnessAssertionError';
    if (context !== undefined) this.context = Object.freeze({ ...context });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown for transport / wiring failures and not-yet-implemented features. */
export class MockHcmHarnessError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'MockHcmHarnessError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
