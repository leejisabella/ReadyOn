import { z } from 'zod';

/**
 * Webhook envelopes that HCM may POST to our inbound endpoint.
 *
 * The wire schema is intentionally minimal: a dedup-stable `eventId`, the
 * `hcmVersion` that determines ordering (TRD §10.1), the informational
 * `appliedAt`, and the typed `payload`. Signatures live on the HTTP request
 * (header), not in the envelope.
 *
 * @ref docs/01_TRD.md §10.1
 */

// Internal helpers, duplicated from schemas.ts to avoid coupling the two files
// to each other. Webhook validation needs to keep working even if the read/
// mutation contract evolves.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO-8601 date YYYY-MM-DD');
const isoTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/,
    'must be ISO-8601 timestamp with explicit timezone',
  );
const bigintFromString = z
  .string()
  .regex(/^-?\d+$/, 'must be a base-10 integer string')
  .transform((s) => BigInt(s));
const nonEmptyString = z.string().min(1);
const decimalString = z.string().min(1);

/** Marker for every webhook the service recognizes. */
export const HCM_WEBHOOK_TYPES = [
  'BALANCE_UPDATED',
  'EMPLOYMENT_CHANGED',
  'LEAVE_TYPE_CHANGED',
  'EMPLOYEE_CREATED',
] as const;

export type HcmWebhookType = (typeof HCM_WEBHOOK_TYPES)[number];

const envelopeShape = <T extends HcmWebhookType, P extends z.ZodTypeAny>(
  type: T,
  payload: P,
) =>
  z
    .object({
      eventId: nonEmptyString,
      type: z.literal(type),
      hcmVersion: bigintFromString,
      appliedAt: isoTimestamp,
      payload,
    })
    .strict();

/**
 * Balance changed on HCM (anniversary bump, retro correction, external reduce,
 * confirmation of our own debit). `available` arrives as a decimal string so
 * the inbox processor can store it without rounding; precision is per leave
 * type.
 */
export const BalanceUpdatedEventSchema = envelopeShape(
  'BALANCE_UPDATED',
  z
    .object({
      employeeId: nonEmptyString,
      locationId: nonEmptyString,
      leaveTypeId: nonEmptyString,
      available: decimalString,
    })
    .strict(),
);

/** Employee transferred or hired into a location for some effective range. */
export const EmploymentChangedEventSchema = envelopeShape(
  'EMPLOYMENT_CHANGED',
  z
    .object({
      employeeId: nonEmptyString,
      locationId: nonEmptyString,
      effectiveFrom: isoDate,
      effectiveTo: isoDate.nullable().optional(),
    })
    .strict(),
);

/** A `(locationId, leaveTypeId)` pair was activated or deactivated. */
export const LeaveTypeChangedEventSchema = envelopeShape(
  'LEAVE_TYPE_CHANGED',
  z
    .object({
      locationId: nonEmptyString,
      leaveTypeId: nonEmptyString,
      isActive: z.boolean(),
      effectiveFrom: isoDate,
      effectiveTo: isoDate.nullable().optional(),
    })
    .strict(),
);

/**
 * A new employee was added to HCM. The payload carries the initial employment
 * row so the bootstrap path (TRD §11.2) can populate `Employment` atomically
 * with the `Employee` row.
 */
export const EmployeeCreatedEventSchema = envelopeShape(
  'EMPLOYEE_CREATED',
  z
    .object({
      employeeId: nonEmptyString,
      employment: z
        .object({
          locationId: nonEmptyString,
          effectiveFrom: isoDate,
        })
        .strict(),
    })
    .strict(),
);

/**
 * Top-level envelope discriminated on `type`. Parse incoming webhook bodies
 * with `HcmWebhookEnvelopeSchema.safeParse(body)` and route on the `.type`.
 *
 * @ref docs/01_TRD.md §10.1
 */
export const HcmWebhookEnvelopeSchema = z.discriminatedUnion('type', [
  BalanceUpdatedEventSchema,
  EmploymentChangedEventSchema,
  LeaveTypeChangedEventSchema,
  EmployeeCreatedEventSchema,
]);

export type BalanceUpdatedEvent = z.output<typeof BalanceUpdatedEventSchema>;
export type EmploymentChangedEvent = z.output<typeof EmploymentChangedEventSchema>;
export type LeaveTypeChangedEvent = z.output<typeof LeaveTypeChangedEventSchema>;
export type EmployeeCreatedEvent = z.output<typeof EmployeeCreatedEventSchema>;
export type HcmWebhookEnvelope = z.output<typeof HcmWebhookEnvelopeSchema>;
