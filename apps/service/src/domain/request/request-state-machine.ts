import { DomainError } from '@time-off/domain-types';

/**
 * Every state in the request lifecycle (TRD §6.2).
 *
 * Terminal states (no outgoing transitions): `REJECTED`, `CANCELLED`,
 * `TAKEN`, `ESCALATED_TO_HR`.
 */
export type RequestState =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'AWAITING_HCM_COMMIT'
  | 'PROVISIONALLY_APPROVED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLATION_PENDING'
  | 'CANCELLED'
  | 'TAKEN'
  | 'NEEDS_REVALIDATION'
  | 'ESCALATED_TO_HR';

/**
 * The full transition table. Source of truth for {@link RequestStateMachine}
 * and (transitively) for `time_off_request.state` CHECK-constraint coverage.
 *
 * Adding a transition: extend the array for the source state. Adding a state:
 * add a key here AND a literal to {@link RequestState}.
 */
const TRANSITIONS: Readonly<Record<RequestState, ReadonlyArray<RequestState>>> = Object.freeze({
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: [
    'APPROVED',
    'AWAITING_HCM_COMMIT',
    'REJECTED',
    'CANCELLED',
    'PROVISIONALLY_APPROVED',
    'NEEDS_REVALIDATION',
  ],
  AWAITING_HCM_COMMIT: ['APPROVED', 'REJECTED'],
  PROVISIONALLY_APPROVED: [
    'APPROVED',
    'ESCALATED_TO_HR',
    'CANCELLED',
    'TAKEN',
    'CANCELLATION_PENDING',
    'NEEDS_REVALIDATION',
  ],
  APPROVED: ['CANCELLATION_PENDING', 'CANCELLED', 'TAKEN', 'NEEDS_REVALIDATION'],
  REJECTED: [],
  CANCELLATION_PENDING: ['CANCELLED'],
  CANCELLED: [],
  TAKEN: [],
  NEEDS_REVALIDATION: ['PENDING_APPROVAL', 'REJECTED'],
  ESCALATED_TO_HR: [],
});

/**
 * Pure transition rules. No I/O, no dependencies — exclusively the
 * "can I move from X to Y" question.
 *
 * @ref docs/01_TRD.md §6.2
 */
export class RequestStateMachine {
  static canTransition(from: RequestState, to: RequestState): boolean {
    return TRANSITIONS[from].includes(to);
  }

  /**
   * Throws `DomainError(STATE_TRANSITION_NOT_ALLOWED)` when the transition is
   * illegal. Use this at every transition site as a defensive guard.
   */
  static assertTransition(from: RequestState, to: RequestState): void {
    if (!this.canTransition(from, to)) {
      throw new DomainError({
        code: 'STATE_TRANSITION_NOT_ALLOWED',
        message: `cannot transition request from ${from} to ${to}`,
        details: { from, to },
      });
    }
  }

  static isTerminal(state: RequestState): boolean {
    return TRANSITIONS[state].length === 0;
  }
}
