/**
 * HcmPort interface + zod schemas, shared between service adapters and the Mock HCM.
 *
 * Populated in Slice 3 (HCM port interface + zod schemas including queryTransactions
 * for Rev 3 exactly-once and EMPLOYEE_NOT_FOUND for Rev 3.1 Q.ν).
 *
 * @ref docs/01_TRD.md §13.2, §13.2.1
 */
export const HCM_PORT_PACKAGE = '@time-off/hcm-port' as const;
