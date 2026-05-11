import { ERROR_CODE_METADATA, isErrorCode, type ErrorCode, type Retryable } from './error-code';

/**
 * Options accepted by {@link DomainError}'s constructor.
 *
 * `message` defaults to the per-code default in {@link ERROR_CODE_METADATA};
 * pass an explicit one when the call site can be more specific.
 */
export interface DomainErrorOptions {
  readonly code: ErrorCode;
  readonly message?: string;
  readonly field?: string;
  readonly correlationId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Canonical error type for every domain failure.
 *
 * Domain code throws `DomainError` with one of the codes in TRD §14.6; the
 * API layer formats it into a GraphQL error payload via `ErrorMapper`
 * (introduced in Slice 3+ when GraphQL is wired). Internal callers route on
 * `code` and `retryable` without parsing strings.
 *
 * @invariant The `retryable` field always matches the metadata entry for
 *   `code` — call sites cannot override it.
 * @invariant Instances are deeply read-only at the public surface.
 *
 * @ref docs/01_TRD.md §14.6
 * @ref docs/04_Module_Plan.md §10
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: Retryable;
  readonly field?: string;
  readonly correlationId?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(opts: DomainErrorOptions) {
    if (!isErrorCode(opts.code)) {
      throw new TypeError(`DomainError constructed with unknown code: ${String(opts.code)}`);
    }
    const meta = ERROR_CODE_METADATA[opts.code];
    super(opts.message ?? meta.defaultMessage, opts.cause !== undefined ? { cause: opts.cause } : undefined);

    this.name = 'DomainError';
    this.code = opts.code;
    this.retryable = meta.retryable;
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.correlationId !== undefined) this.correlationId = opts.correlationId;
    if (opts.details !== undefined) {
      this.details = Object.freeze({ ...opts.details });
    }

    // Restore prototype so `instanceof DomainError` works after `super()` (Babel/older targets).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Compact JSON-ready shape suitable for the GraphQL `errors` extension or
   * for structured log output. Stable across versions — additive only.
   */
  toJSON(): {
    code: ErrorCode;
    message: string;
    retryable: Retryable;
    field?: string;
    correlationId?: string;
    details?: Readonly<Record<string, unknown>>;
  } {
    const out: ReturnType<DomainError['toJSON']> = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.field !== undefined) out.field = this.field;
    if (this.correlationId !== undefined) out.correlationId = this.correlationId;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/**
 * Convenience guard. Useful in `catch` blocks where `unknown` is the inferred
 * type and the caller wants to discriminate domain errors from infrastructure
 * exceptions (HCM transport errors, database errors, etc.).
 */
export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
