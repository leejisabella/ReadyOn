/**
 * HCM port: interface + zod schemas + typed errors.
 *
 * Used by:
 *   - `apps/service`: imports {@link HcmPort} (and concrete adapter implements it).
 *   - `apps/mock-hcm`: implements the wire shape this port describes.
 *
 * @ref docs/04_Module_Plan.md §1, §5.1
 */

export type { HcmPort } from './port';

export {
  HcmBatchEntrySchema,
  HcmEmployeeResponseSchema,
  HcmEmploymentResponseSchema,
  HcmFetchBalanceResponseSchema,
  HcmLeaveTypesResponseSchema,
  HcmMutationResponseSchema,
  HcmTransactionHistorySchema,
  HcmTransactionRecordSchema,
} from './schemas';
export type {
  FetchBalanceArgs,
  HcmBatchEntry,
  HcmEmployeeResponse,
  HcmEmploymentPeriod,
  HcmEmploymentResponse,
  HcmFetchBalanceResponse,
  HcmLeaveTypeEntry,
  HcmLeaveTypesResponse,
  HcmMutationResponse,
  HcmTransactionHistory,
  HcmTransactionQuery,
  HcmTransactionRecord,
  ReleaseBalanceArgs,
  ReserveBalanceArgs,
} from './schemas';

export {
  BalanceUpdatedEventSchema,
  EmployeeCreatedEventSchema,
  EmploymentChangedEventSchema,
  HCM_WEBHOOK_TYPES,
  HcmWebhookEnvelopeSchema,
  LeaveTypeChangedEventSchema,
} from './events';
export type {
  BalanceUpdatedEvent,
  EmployeeCreatedEvent,
  EmploymentChangedEvent,
  HcmWebhookEnvelope,
  HcmWebhookType,
  LeaveTypeChangedEvent,
} from './events';

export {
  HcmContractViolation,
  HcmEmployeeNotFoundError,
  HcmError,
  HcmPermanentError,
  HcmTransientError,
} from './errors';
export type { HcmPermanentReason } from './errors';
