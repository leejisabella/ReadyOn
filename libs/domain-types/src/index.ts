/**
 * Shared domain types for the Time-Off Microservice.
 *
 * @ref docs/04_Module_Plan.md §1
 */
export {
  ERROR_CODES,
  ERROR_CODE_METADATA,
  isErrorCode,
} from './error-code';
export type { ErrorCode, ErrorCodeMetadata, ErrorSurface, Retryable } from './error-code';

export { DomainError, isDomainError } from './domain-error';
export type { DomainErrorOptions } from './domain-error';
