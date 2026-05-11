import type { z } from 'zod';

/**
 * Errors thrown by `HcmPort` implementations.
 *
 * Adapters categorize HCM-side problems into four classes so the outbox
 * worker, reconciler, and saga can route by `instanceof`:
 *
 *  - {@link HcmTransientError}   — caller should retry (5xx, timeout, network).
 *  - {@link HcmPermanentError}   — caller should NOT retry (4xx, auth, etc.).
 *  - {@link HcmContractViolation} — HCM returned 2xx but failed schema validation.
 *  - {@link HcmEmployeeNotFoundError} — Rev 3.1 (Q.ν): a specific permanent case.
 *
 * Semantic business rejections (insufficient balance, invalid dimension) are
 * delivered as {@link HcmPermanentError} with a discriminating `reason`; the
 * adapter does not throw a separate class per reason.
 *
 * @ref docs/01_TRD.md §13.2, §14.6, ADR-027
 * @ref docs/04_Module_Plan.md §3.9, §10
 */

/** Common base. Never thrown directly — use a concrete subclass. */
export abstract class HcmError extends Error {
  abstract readonly retryable: boolean;

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Network failures and 5xx responses. Outbox should back off and retry. */
export class HcmTransientError extends HcmError {
  readonly retryable = true;

  /** Optional `Retry-After` hint (ms). Adapters parse the header and pass it in. */
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { cause?: unknown; retryAfterMs?: number } = {}) {
    super(message, opts.cause);
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * Permanent failure — the request is bad or HCM refuses categorically. Includes
 * semantic business rejections such as insufficient balance, invalid dimension,
 * and authentication failures. The `reason` field discriminates.
 */
export class HcmPermanentError extends HcmError {
  readonly retryable = false;

  /**
   * Discriminator describing why HCM rejected. Adapters map vendor-specific
   * error codes to this set; downstream code can route on it without parsing
   * messages.
   */
  readonly reason: HcmPermanentReason;

  constructor(reason: HcmPermanentReason, message: string, cause?: unknown) {
    super(message, cause);
    this.reason = reason;
  }
}

export type HcmPermanentReason =
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_DIMENSION'
  | 'IDEMPOTENCY_REPLAY_MISMATCH'
  | 'AUTH_FAILED'
  | 'OTHER';

/**
 * HCM returned a 2xx response whose body failed our zod schema. The wrapped
 * `zodIssues` capture the field-level reasons for diagnostics and the
 * `HCM_RESPONSE_INVALID` audit event.
 */
export class HcmContractViolation extends HcmError {
  readonly retryable = false;
  readonly zodIssues: ReadonlyArray<z.ZodIssue>;

  constructor(message: string, zodIssues: ReadonlyArray<z.ZodIssue>, cause?: unknown) {
    super(message, cause);
    this.zodIssues = zodIssues;
  }
}

/**
 * Rev 3.1, Q.ν: HCM has no record of the employee at the moment of query —
 * typically because the employee was deleted between our last sync and now.
 *
 * Distinguished from a generic permanent error so the provisional reconciler
 * can route to `ESCALATED_TO_HR` with `hrReviewReason = "Employee no longer
 * exists in HCM"` (TRD §9.5.3 step 3.1e, ADR-027).
 */
export class HcmEmployeeNotFoundError extends HcmPermanentError {
  readonly employeeId: string;

  constructor(employeeId: string, message?: string, cause?: unknown) {
    super(
      'INVALID_DIMENSION',
      message ?? `HCM has no record of employee ${employeeId}`,
      cause,
    );
    this.employeeId = employeeId;
  }
}
