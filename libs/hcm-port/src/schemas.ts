import type Decimal from 'decimal.js';
import { parseDecimal } from '@time-off/decimal-scalar';
import { z } from 'zod';

/**
 * Wire-format schemas for every value that crosses the HCM boundary.
 *
 * The HCM contract uses strings for decimals (to avoid JSON-number precision
 * loss, ADR-013) and strings for bigints (because JSON has no bigint).
 * Schemas validate the wire shape and transform string fields into the
 * domain types the rest of the service uses (`Decimal`, `bigint`).
 *
 * @ref docs/01_TRD.md §13.2, §13.2.1
 * @ref docs/02_Assumptions_and_Decisions.md ADR-005, ADR-013
 */

// ─── Primitives ──────────────────────────────────────────────────────────────

/** ISO-8601 calendar date, no time component, no timezone. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO-8601 date YYYY-MM-DD');

/** ISO-8601 instant with explicit timezone (Z or numeric offset). */
const isoTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/,
    'must be ISO-8601 timestamp with explicit timezone',
  );

/** Base-10 integer string, parsed to `bigint`. Inclusive of negatives. */
const bigintFromString = z
  .string()
  .regex(/^-?\d+$/, 'must be a base-10 integer string')
  .transform((s) => BigInt(s));

/** Strict decimal string per `parseDecimal`, transformed to `Decimal`. */
const decimalFromString: z.ZodType<Decimal, z.ZodTypeDef, string> = z
  .string()
  .transform((s, ctx) => {
    try {
      return parseDecimal(s);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
      return z.NEVER;
    }
  });

const nonEmptyString = z.string().min(1);

// ─── Mutation I/O ────────────────────────────────────────────────────────────

/**
 * Required HCM mutation confirmation. Every successful reserve/release MUST
 * carry these fields; missing or malformed → contract violation.
 *
 * `deltaApplied` is the SOUND check (TRD §13.3) — arithmetic on
 * `newAvailable - oldAvailable` is unsound under concurrent HCM writers.
 *
 * @ref docs/01_TRD.md §13.2, ADR-005
 */
export const HcmMutationResponseSchema = z
  .object({
    transactionId: nonEmptyString,
    deltaApplied: decimalFromString,
    newAvailable: decimalFromString,
    hcmVersion: bigintFromString,
    appliedAt: isoTimestamp,
  })
  .strict();

export type HcmMutationResponse = z.output<typeof HcmMutationResponseSchema>;

/** Arguments for {@link HcmPort.reserveBalance}. */
export interface ReserveBalanceArgs {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly units: Decimal;
}

/** Arguments for {@link HcmPort.releaseBalance}. Same shape, kept distinct for clarity. */
export interface ReleaseBalanceArgs {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly units: Decimal;
}

// ─── Balance read ────────────────────────────────────────────────────────────

export interface FetchBalanceArgs {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
}

/**
 * Point-read balance response. No transactionId/deltaApplied because nothing
 * was applied — this is HCM telling us its current view.
 */
export const HcmFetchBalanceResponseSchema = z
  .object({
    employeeId: nonEmptyString,
    locationId: nonEmptyString,
    leaveTypeId: nonEmptyString,
    available: decimalFromString,
    hcmVersion: bigintFromString,
    appliedAt: isoTimestamp,
  })
  .strict();

export type HcmFetchBalanceResponse = z.output<typeof HcmFetchBalanceResponseSchema>;

// ─── Employment read ─────────────────────────────────────────────────────────

const HcmEmploymentPeriodSchema = z
  .object({
    locationId: nonEmptyString,
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().optional(),
    hcmVersion: bigintFromString,
  })
  .strict();

export const HcmEmploymentResponseSchema = z
  .object({
    employeeId: nonEmptyString,
    periods: z.array(HcmEmploymentPeriodSchema),
  })
  .strict();

export type HcmEmploymentPeriod = z.output<typeof HcmEmploymentPeriodSchema>;
export type HcmEmploymentResponse = z.output<typeof HcmEmploymentResponseSchema>;

// ─── Leave-type availability read ────────────────────────────────────────────

const HcmLeaveTypeEntrySchema = z
  .object({
    leaveTypeId: nonEmptyString,
    isActive: z.boolean(),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().optional(),
    hcmVersion: bigintFromString,
  })
  .strict();

export const HcmLeaveTypesResponseSchema = z
  .object({
    locationId: nonEmptyString,
    leaveTypes: z.array(HcmLeaveTypeEntrySchema),
  })
  .strict();

export type HcmLeaveTypeEntry = z.output<typeof HcmLeaveTypeEntrySchema>;
export type HcmLeaveTypesResponse = z.output<typeof HcmLeaveTypesResponseSchema>;

// ─── Employee read (lazy-bootstrap; TRD §11.3) ───────────────────────────────

export const HcmEmployeeResponseSchema = z
  .object({
    employeeId: nonEmptyString,
    hcmVersion: bigintFromString,
    employment: z.array(HcmEmploymentPeriodSchema),
  })
  .strict();

export type HcmEmployeeResponse = z.output<typeof HcmEmployeeResponseSchema>;

// ─── Transaction history (Rev 3, §13.2.1) ────────────────────────────────────

/**
 * Pre-flight history query input. The provisional reconciler uses this to
 * discover whether HCM already applied a transaction with our idempotency key
 * before issuing a fresh reserve/release.
 *
 * @ref docs/01_TRD.md §13.2.1, §9.5.3, ADR-018
 */
export interface HcmTransactionQuery {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  /** Filter results to the transaction with this client-supplied key. */
  readonly idempotencyKey?: string;
  /** Optional inclusive bounds for `appliedAt`. Defaults to "no bound" at the adapter. */
  readonly window?: { readonly start: string; readonly end: string };
}

export const HcmTransactionRecordSchema = z
  .object({
    transactionId: nonEmptyString,
    idempotencyKey: nonEmptyString.optional(),
    deltaApplied: decimalFromString,
    appliedAt: isoTimestamp,
    hcmVersion: bigintFromString,
  })
  .strict();

export type HcmTransactionRecord = z.output<typeof HcmTransactionRecordSchema>;

/** HCM's response to a transaction-history query is a list of records. */
export const HcmTransactionHistorySchema = z.array(HcmTransactionRecordSchema);
export type HcmTransactionHistory = z.output<typeof HcmTransactionHistorySchema>;

// ─── Batch dump (TRD §10.2) ──────────────────────────────────────────────────

/**
 * One balance row in the daily batch corpus. Bootstrap-from-batch (TRD §11.4)
 * uses these rows to discover unknown employees and trigger an
 * `ensureBootstrapped` lazy-pull for their employment.
 */
export const HcmBatchEntrySchema = z
  .object({
    employeeId: nonEmptyString,
    locationId: nonEmptyString,
    leaveTypeId: nonEmptyString,
    available: decimalFromString,
    hcmVersion: bigintFromString,
    appliedAt: isoTimestamp,
  })
  .strict();

export type HcmBatchEntry = z.output<typeof HcmBatchEntrySchema>;
