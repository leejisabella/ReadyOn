/**
 * Canonical error taxonomy for the Time-Off Microservice.
 *
 * Every domain error returned by any service mutation maps to one of these codes.
 * Metadata (retryability, where the code can surface) is the contract the
 * caller can rely on without inspecting individual code paths.
 *
 * @ref docs/01_TRD.md §14.6
 * @ref docs/02_Assumptions_and_Decisions.md ADR-010
 */

/**
 * Three-state retryability classification.
 *
 * - `yes` — the caller may retry the same request and expect it to succeed
 *   eventually (transient failure).
 * - `no` — retrying will not change the outcome; the caller must change input
 *   or external state.
 * - `na` — the code is internal/informational and is not directly raised at a
 *   caller surface (e.g., HR_REVIEW_REQUIRED is a marker, not an error).
 */
export type Retryable = 'yes' | 'no' | 'na';

/**
 * The set of mutations or surfaces where a given error code can be observed.
 *
 * `internal` means the code is raised inside a worker or reconciler and routed
 * (via escalation, audit) rather than returned to a client. `read` means the
 * code is informational and surfaces only on read APIs.
 */
export type ErrorSurface =
  | 'create'
  | 'approve'
  | 'approveProvisionally'
  | 'reject'
  | 'cancel'
  | 'read'
  | 'internal';

/**
 * All error codes that can be carried by a {@link DomainError}.
 *
 * The order in this tuple matches the order in TRD §14.6. New codes must be
 * added to this list AND to {@link ERROR_CODE_METADATA} in the same change.
 */
export const ERROR_CODES = [
  'INSUFFICIENT_BALANCE_LOCAL',
  'INSUFFICIENT_BALANCE_HCM',
  'INVALID_DIMENSION',
  'INVALID_DATES',
  'STATE_TRANSITION_NOT_ALLOWED',
  'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT',
  'BALANCE_UNDER_RECONCILIATION',
  'HCM_UNAVAILABLE',
  'HCM_RESPONSE_INVALID',
  'POLICY_VIOLATION',
  'REQUEST_SPANS_LOCATION_TRANSFER',
  'LEAVE_TYPE_NOT_AVAILABLE_AT_NEW_LOCATION',
  'EMPLOYMENT_NOT_FOUND',
  'LEAVE_TYPE_NOT_AVAILABLE',
  'REQUEST_NOT_FOUND',
  'TERMINAL_STATE_REACHED',
  'BREAK_GLASS_NOT_AUTHORIZED',
  'BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET',
  'PROVISIONAL_RECONCILIATION_REJECTED',
  'PROVISIONAL_RECONCILIATION_TRANSIENT_FAILURE',
  'PROVISIONAL_RECONCILIATION_ALREADY_RECONCILED',
  'EMPLOYEE_NOT_BOOTSTRAPPED',
  'CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT',
  'HR_REVIEW_REQUIRED',
  'EMPLOYEE_NOT_FOUND_AT_HCM_DURING_RECONCILIATION',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Per-code metadata. Every {@link ErrorCode} MUST have a corresponding entry.
 *
 * @invariant Every key in {@link ERROR_CODES} appears here exactly once.
 * @invariant `defaultMessage` is in English; localization is future work
 *   (TRD §2 non-goals). It is safe to display to internal operators but
 *   client UIs should render their own copy.
 */
export interface ErrorCodeMetadata {
  readonly retryable: Retryable;
  readonly surfaces: ReadonlyArray<ErrorSurface>;
  readonly defaultMessage: string;
}

export const ERROR_CODE_METADATA: Readonly<Record<ErrorCode, ErrorCodeMetadata>> = Object.freeze({
  INSUFFICIENT_BALANCE_LOCAL: {
    retryable: 'no',
    surfaces: ['create'],
    defaultMessage: 'Local projection shows insufficient balance for this request (advisory).',
  },
  INSUFFICIENT_BALANCE_HCM: {
    retryable: 'no',
    surfaces: ['create', 'approve', 'internal'],
    defaultMessage: 'HCM rejected the operation for insufficient balance.',
  },
  INVALID_DIMENSION: {
    retryable: 'no',
    surfaces: ['create', 'approve'],
    defaultMessage: 'The (employee, location, leave type) combination is not valid at HCM.',
  },
  INVALID_DATES: {
    retryable: 'no',
    surfaces: ['create'],
    defaultMessage: 'Date range is invalid (end before start, zero units, or malformed).',
  },
  STATE_TRANSITION_NOT_ALLOWED: {
    retryable: 'no',
    surfaces: ['create', 'approve', 'approveProvisionally', 'reject', 'cancel'],
    defaultMessage: 'The requested state transition is not permitted from the current state.',
  },
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT: {
    retryable: 'no',
    surfaces: ['create', 'approve', 'approveProvisionally', 'reject', 'cancel'],
    defaultMessage: 'Idempotency key was previously used with a different input.',
  },
  BALANCE_UNDER_RECONCILIATION: {
    retryable: 'yes',
    surfaces: ['create', 'approve'],
    defaultMessage: 'Balance is currently being reconciled; retry shortly.',
  },
  HCM_UNAVAILABLE: {
    retryable: 'yes',
    surfaces: ['create', 'approve'],
    defaultMessage: 'HCM is currently unreachable.',
  },
  HCM_RESPONSE_INVALID: {
    retryable: 'yes',
    surfaces: ['internal'],
    defaultMessage: 'HCM returned a response that failed contract validation.',
  },
  POLICY_VIOLATION: {
    retryable: 'no',
    surfaces: ['create'],
    defaultMessage: 'Request would violate a configured policy (advisory UX hint).',
  },
  REQUEST_SPANS_LOCATION_TRANSFER: {
    retryable: 'no',
    surfaces: ['create'],
    defaultMessage: 'Request date range crosses an employment location boundary.',
  },
  LEAVE_TYPE_NOT_AVAILABLE_AT_NEW_LOCATION: {
    retryable: 'no',
    surfaces: ['internal'],
    defaultMessage: 'Leave type is not available at the new location after revalidation.',
  },
  EMPLOYMENT_NOT_FOUND: {
    retryable: 'no',
    surfaces: ['create'],
    defaultMessage: 'No active employment record exists for the requested date.',
  },
  LEAVE_TYPE_NOT_AVAILABLE: {
    retryable: 'no',
    surfaces: ['create'],
    defaultMessage: 'Leave type is not active at the resolved location.',
  },
  REQUEST_NOT_FOUND: {
    retryable: 'no',
    surfaces: ['approve', 'approveProvisionally', 'reject', 'cancel', 'read'],
    defaultMessage: 'No request exists with the supplied identifier.',
  },
  TERMINAL_STATE_REACHED: {
    retryable: 'no',
    surfaces: ['cancel'],
    defaultMessage: 'Request is in a terminal state and cannot be modified.',
  },
  BREAK_GLASS_NOT_AUTHORIZED: {
    retryable: 'no',
    surfaces: ['approveProvisionally'],
    defaultMessage: 'Caller lacks the break_glass_approver role required for provisional approval.',
  },
  BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET: {
    retryable: 'no',
    surfaces: ['approveProvisionally'],
    defaultMessage: 'HCM has not been unavailable long enough for break-glass approval.',
  },
  PROVISIONAL_RECONCILIATION_REJECTED: {
    retryable: 'na',
    surfaces: ['internal'],
    defaultMessage: 'HCM rejected a provisional decision during reconciliation; escalated to HR.',
  },
  PROVISIONAL_RECONCILIATION_TRANSIENT_FAILURE: {
    retryable: 'yes',
    surfaces: ['internal'],
    defaultMessage: 'Transient HCM failure during provisional reconciliation; will retry.',
  },
  PROVISIONAL_RECONCILIATION_ALREADY_RECONCILED: {
    retryable: 'no',
    surfaces: ['internal'],
    defaultMessage: 'Attempted to reconcile a provisional action that is already terminal.',
  },
  EMPLOYEE_NOT_BOOTSTRAPPED: {
    retryable: 'no',
    surfaces: ['create'],
    defaultMessage: 'Employee is unknown to the service and HCM lookup failed.',
  },
  CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT: {
    retryable: 'no',
    surfaces: ['cancel'],
    defaultMessage:
      'Cancellation during HCM outage requires acknowledgedHcmUnavailable: true on the input.',
  },
  HR_REVIEW_REQUIRED: {
    retryable: 'na',
    surfaces: ['read'],
    defaultMessage: 'Request is flagged for HR review; surfaces via hrReviewQueue.',
  },
  EMPLOYEE_NOT_FOUND_AT_HCM_DURING_RECONCILIATION: {
    retryable: 'na',
    surfaces: ['internal'],
    defaultMessage:
      'Employee record no longer exists at HCM when the reconciler queried; escalated to HR.',
  },
});

/**
 * Type guard for plain string values that happen to be valid {@link ErrorCode}s.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
