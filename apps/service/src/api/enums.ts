import { registerEnumType } from '@nestjs/graphql';

/**
 * GraphQL enum registrations. Each one mirrors the domain literal union of
 * the same name; the GraphQL schema generator picks them up by registered
 * `name` so resolvers can return raw string values.
 *
 * @ref docs/01_TRD.md §6.2, §7.1
 */

export enum RequestState {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  AWAITING_HCM_COMMIT = 'AWAITING_HCM_COMMIT',
  PROVISIONALLY_APPROVED = 'PROVISIONALLY_APPROVED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLATION_PENDING = 'CANCELLATION_PENDING',
  CANCELLED = 'CANCELLED',
  TAKEN = 'TAKEN',
  NEEDS_REVALIDATION = 'NEEDS_REVALIDATION',
  ESCALATED_TO_HR = 'ESCALATED_TO_HR',
}
registerEnumType(RequestState, { name: 'RequestState' });

export enum BalanceState {
  SYNCED = 'SYNCED',
  RECONCILING = 'RECONCILING',
  UNDER_HOLD_DEFICIT = 'UNDER_HOLD_DEFICIT',
  STALE = 'STALE',
}
registerEnumType(BalanceState, { name: 'BalanceState' });

export enum ProvisionalActionTypeEnum {
  BREAK_GLASS_APPROVAL = 'BREAK_GLASS_APPROVAL',
  PROVISIONAL_CANCELLATION = 'PROVISIONAL_CANCELLATION',
}
registerEnumType(ProvisionalActionTypeEnum, { name: 'ProvisionalActionType' });

export enum ProvisionalReconciliationState {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  REJECTED_ESCALATED = 'REJECTED_ESCALATED',
  NO_OP = 'NO_OP',
}
registerEnumType(ProvisionalReconciliationState, { name: 'ProvisionalReconciliationState' });

export enum ReconciliationStepKindEnum {
  HCM_HISTORY_QUERIED = 'HCM_HISTORY_QUERIED',
  HCM_HISTORY_QUERY_FAILED = 'HCM_HISTORY_QUERY_FAILED',
  HISTORY_MISMATCH = 'HISTORY_MISMATCH',
  HCM_CALL_IN_FLIGHT = 'HCM_CALL_IN_FLIGHT',
  OUTCOME_APPLIED = 'OUTCOME_APPLIED',
  OUTCOME_INVALID = 'OUTCOME_INVALID',
  PAIR_COALESCED = 'PAIR_COALESCED',
  EMPLOYEE_NOT_FOUND_AT_HCM = 'EMPLOYEE_NOT_FOUND_AT_HCM',
  TERMINAL = 'TERMINAL',
}
registerEnumType(ReconciliationStepKindEnum, { name: 'ReconciliationStepKind' });

export enum ReconciliationStepOutcomeEnum {
  PARTIAL = 'PARTIAL',
  TERMINAL = 'TERMINAL',
}
registerEnumType(ReconciliationStepOutcomeEnum, { name: 'ReconciliationStepOutcome' });

export enum HrReviewCategoryEnum {
  ESCALATED_PRE_LEAVE = 'ESCALATED_PRE_LEAVE',
  ESCALATED_POST_LEAVE = 'ESCALATED_POST_LEAVE',
  CANCELLATION_STUCK = 'CANCELLATION_STUCK',
}
registerEnumType(HrReviewCategoryEnum, { name: 'HrReviewCategory' });

export enum ReconciliationJobKind {
  BATCH = 'BATCH',
  PROVISIONAL = 'PROVISIONAL',
  POINT_READ = 'POINT_READ',
}
registerEnumType(ReconciliationJobKind, { name: 'ReconciliationJobKind' });
