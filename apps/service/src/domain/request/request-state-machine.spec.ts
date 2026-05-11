import { DomainError } from '@time-off/domain-types';
import { RequestStateMachine, type RequestState } from './request-state-machine';

describe('RequestStateMachine', () => {
  describe('canTransition — saga happy paths (TRD §6.2)', () => {
    it.each<[RequestState, RequestState]>([
      ['DRAFT', 'PENDING_APPROVAL'],
      ['PENDING_APPROVAL', 'APPROVED'],
      ['PENDING_APPROVAL', 'REJECTED'],
      ['PENDING_APPROVAL', 'CANCELLED'],
      ['PENDING_APPROVAL', 'PROVISIONALLY_APPROVED'],
      ['PENDING_APPROVAL', 'NEEDS_REVALIDATION'],
      ['PENDING_APPROVAL', 'AWAITING_HCM_COMMIT'],
      ['AWAITING_HCM_COMMIT', 'APPROVED'],
      ['AWAITING_HCM_COMMIT', 'REJECTED'],
      ['PROVISIONALLY_APPROVED', 'APPROVED'],
      ['PROVISIONALLY_APPROVED', 'ESCALATED_TO_HR'],
      ['PROVISIONALLY_APPROVED', 'CANCELLED'],
      ['PROVISIONALLY_APPROVED', 'TAKEN'],
      ['APPROVED', 'CANCELLATION_PENDING'],
      ['APPROVED', 'CANCELLED'],
      ['APPROVED', 'TAKEN'],
      ['APPROVED', 'NEEDS_REVALIDATION'],
      ['CANCELLATION_PENDING', 'CANCELLED'],
      ['NEEDS_REVALIDATION', 'PENDING_APPROVAL'],
      ['NEEDS_REVALIDATION', 'REJECTED'],
    ])('%s → %s', (from, to) => {
      expect(RequestStateMachine.canTransition(from, to)).toBe(true);
    });
  });

  describe('canTransition — common illegal transitions', () => {
    it.each<[RequestState, RequestState]>([
      ['REJECTED', 'APPROVED'],
      ['CANCELLED', 'PENDING_APPROVAL'],
      ['TAKEN', 'APPROVED'],
      ['TAKEN', 'CANCELLED'],
      ['ESCALATED_TO_HR', 'APPROVED'],
      ['APPROVED', 'PENDING_APPROVAL'],
      ['PENDING_APPROVAL', 'TAKEN'],
      ['DRAFT', 'APPROVED'],
    ])('%s ↛ %s', (from, to) => {
      expect(RequestStateMachine.canTransition(from, to)).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('passes silently on a legal transition', () => {
      expect(() => RequestStateMachine.assertTransition('PENDING_APPROVAL', 'APPROVED')).not.toThrow();
    });

    it('throws DomainError(STATE_TRANSITION_NOT_ALLOWED) on an illegal transition', () => {
      try {
        RequestStateMachine.assertTransition('APPROVED', 'PENDING_APPROVAL');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('STATE_TRANSITION_NOT_ALLOWED');
        expect((err as DomainError).details).toEqual({ from: 'APPROVED', to: 'PENDING_APPROVAL' });
      }
    });
  });

  describe('isTerminal', () => {
    it.each<RequestState>(['REJECTED', 'CANCELLED', 'TAKEN', 'ESCALATED_TO_HR'])(
      '%s is terminal',
      (state) => {
        expect(RequestStateMachine.isTerminal(state)).toBe(true);
      },
    );

    it.each<RequestState>([
      'DRAFT',
      'PENDING_APPROVAL',
      'AWAITING_HCM_COMMIT',
      'PROVISIONALLY_APPROVED',
      'APPROVED',
      'CANCELLATION_PENDING',
      'NEEDS_REVALIDATION',
    ])('%s is NOT terminal', (state) => {
      expect(RequestStateMachine.isTerminal(state)).toBe(false);
    });
  });
});
