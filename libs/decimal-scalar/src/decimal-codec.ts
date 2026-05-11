import Decimal from 'decimal.js';

/**
 * Decimal serialization helpers used everywhere a Decimal crosses a string
 * boundary (GraphQL, SQLite, HCM port, audit log).
 *
 * The codec exists so that no part of the system performs ad-hoc string
 * construction or `Number(x)` parsing on a Decimal value — both lose precision
 * silently.
 *
 * @ref docs/01_TRD.md §14.5
 * @ref docs/02_Assumptions_and_Decisions.md ADR-013
 */

/**
 * Strict pattern for the decimal strings we accept across boundaries.
 *
 * Permits optional leading sign, integer part, optional fractional part. No
 * scientific notation, no leading zeros except `0.x`, no whitespace.
 * `decimal.js` itself accepts a wider set; the boundary is stricter on purpose
 * so we catch typos and round-trip surprises early.
 */
const STRICT_DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Parse a decimal value from a string or number into a {@link Decimal}.
 *
 * Strings are validated against {@link STRICT_DECIMAL_PATTERN} before being
 * handed to `decimal.js`. Numbers are accepted but discouraged at integration
 * boundaries (Number→string→Decimal can leak float artifacts at very large
 * magnitudes); callers that have a choice should prefer strings.
 *
 * @throws TypeError if the input is not a string or finite number.
 * @throws RangeError if the input is NaN, ±Infinity, or a malformed string.
 */
export function parseDecimal(value: string | number): Decimal {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`parseDecimal: refusing non-finite number ${value}`);
    }
    return new Decimal(value);
  }
  if (typeof value === 'string') {
    if (!STRICT_DECIMAL_PATTERN.test(value)) {
      throw new RangeError(`parseDecimal: string does not match strict pattern: ${JSON.stringify(value)}`);
    }
    return new Decimal(value);
  }
  throw new TypeError(`parseDecimal: expected string or number, got ${typeof value}`);
}

/**
 * Serialize a Decimal to its canonical string form at a specific precision.
 *
 * `precision` is the number of fractional digits — same semantics as
 * `Decimal.prototype.toFixed(precision)`. Inputs more precise than `precision`
 * are rounded using `decimal.js`'s configured rounding mode (default
 * `ROUND_HALF_UP`). Inputs less precise are zero-padded.
 *
 * @example
 *   serializeDecimal(new Decimal('2'),     2) // → "2.00"
 *   serializeDecimal(new Decimal('2.5'),   2) // → "2.50"
 *   serializeDecimal(new Decimal('-1.235'), 2) // → "-1.24" (default rounding)
 */
export function serializeDecimal(value: Decimal, precision: number): string {
  if (!Number.isInteger(precision) || precision < 0) {
    throw new RangeError(`serializeDecimal: precision must be a non-negative integer, got ${precision}`);
  }
  return value.toFixed(precision);
}

/**
 * Format a Decimal in its natural (fixed-notation, no trailing zero) form.
 * Used by the GraphQL scalar where no domain-level precision is known.
 *
 * Compared to `value.toString()`, this guarantees no scientific notation even
 * for very large or very small values.
 */
export function formatDecimalNatural(value: Decimal): string {
  // toFixed() with no args returns fixed-point notation at the value's natural
  // precision (no rounding, no scientific notation).
  return value.toFixed();
}
