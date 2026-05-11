/**
 * Shared domain types for the Time-Off Microservice.
 *
 * Populated in subsequent slices (Slice 2 introduces ErrorCode, Slice 3 the
 * request/balance/employment shapes). Keeping this barrel non-empty so
 * downstream packages can depend on it from Slice 1.
 *
 * @ref docs/04_Module_Plan.md §1
 */
export const DOMAIN_TYPES_PACKAGE = '@time-off/domain-types' as const;
