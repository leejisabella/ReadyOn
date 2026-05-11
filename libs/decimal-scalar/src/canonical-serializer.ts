import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { parseDecimal, serializeDecimal } from './decimal-codec';

/**
 * Canonical input serializer for idempotency hashing.
 *
 * Two clients that send semantically-equivalent inputs MUST produce
 * byte-identical canonical output, regardless of:
 *
 *  - field ordering in JSON,
 *  - whitespace,
 *  - Unicode normalization form (NFC vs NFD),
 *  - date string format (date-only vs ISO datetime),
 *  - decimal representation (`2`, `2.0`, `"2.00"`, …),
 *  - presence of fields not declared in the spec.
 *
 * @invariant For any two values `a`, `b` such that `a` and `b` differ ONLY in
 *   the canonicalization-equivalence dimensions listed above, the
 *   `hash(a, spec)` equals `hash(b, spec)`. This is the property-based test
 *   T-PROP-12 in `03_Test_Plan.md`.
 *
 * @invariant `canonicalize` output is valid UTF-8 JSON with no extra
 *   whitespace.
 *
 * @ref docs/01_TRD.md §14.4
 * @ref docs/02_Assumptions_and_Decisions.md ADR-014
 */

/**
 * Field schema used to drive canonicalization. The caller declares the shape
 * of the input it accepts; the serializer enforces it.
 *
 * Fields not present in the spec are dropped before hashing (per TRD §14.4
 * rule 8 — "unknown fields stripped"), so adding a field to the schema does
 * not invalidate hashes of inputs that don't reference it.
 */
export type FieldKind =
  | { readonly kind: 'string' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'decimal'; readonly precision: number }
  | { readonly kind: 'date' }
  | { readonly kind: 'datetime' }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, FieldKind>> }
  | { readonly kind: 'array'; readonly element: FieldKind };

/** Convenience aliases for callers building specs. */
export const fk = Object.freeze({
  string: { kind: 'string' as const } satisfies FieldKind,
  boolean: { kind: 'boolean' as const } satisfies FieldKind,
  integer: { kind: 'integer' as const } satisfies FieldKind,
  decimal: (precision: number): FieldKind => ({ kind: 'decimal', precision }),
  date: { kind: 'date' as const } satisfies FieldKind,
  datetime: { kind: 'datetime' as const } satisfies FieldKind,
  object: (fields: Record<string, FieldKind>): FieldKind => ({ kind: 'object', fields }),
  array: (element: FieldKind): FieldKind => ({ kind: 'array', element }),
});

/** Thrown when input fails spec validation during canonicalization. */
export class CanonicalSerializationError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`canonicalize at ${path || '<root>'}: ${message}`);
    this.name = 'CanonicalSerializationError';
    this.path = path;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Canonicalizer per TRD §14.4. Stateless and reentrant — a single instance
 * may be shared across the app.
 */
export class CanonicalInputSerializer {
  /**
   * Reduce `value` to a deterministic UTF-8 byte sequence per its `spec`.
   *
   * @throws {@link CanonicalSerializationError} when an input cannot be
   *   coerced to the declared field kind.
   */
  canonicalize(value: unknown, spec: FieldKind): Buffer {
    const normalized = normalize(value, spec, '');
    // JSON.stringify with no `space` argument produces no whitespace
    // (TRD §14.4 rule 2). Object iteration order follows insertion order,
    // which we control by inserting keys in sorted order at each level.
    return Buffer.from(JSON.stringify(normalized), 'utf8');
  }

  /**
   * SHA-256 hex digest over the canonical bytes. Suitable for the
   * `IdempotencyKey.inputHash` column.
   *
   * @ref docs/01_TRD.md §14.4 rule 9
   */
  hash(value: unknown, spec: FieldKind): string {
    return createHash('sha256').update(this.canonicalize(value, spec)).digest('hex');
  }
}

// --- internals --------------------------------------------------------------

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

function normalize(value: unknown, spec: FieldKind, path: string): JsonValue {
  // null/undefined at a non-object position: object handling drops them
  // upstream, so we only reach here for declared-but-null array elements or
  // direct primitives. Keep them as JSON null per TRD §14.4 rule 6.
  if (value === undefined || value === null) {
    return null;
  }

  switch (spec.kind) {
    case 'string':
      if (typeof value !== 'string') {
        throw new CanonicalSerializationError(`expected string, got ${typeOf(value)}`, path);
      }
      // TRD §14.4 rule 3: NFC normalization (resolves NFC vs NFD ambiguity).
      return value.normalize('NFC');

    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new CanonicalSerializationError(`expected boolean, got ${typeOf(value)}`, path);
      }
      return value;

    case 'integer': {
      const asDecimal = coerceNumericForInteger(value, path);
      if (!asDecimal.isInteger()) {
        throw new CanonicalSerializationError(
          `expected integer, got non-integer ${asDecimal.toFixed()}`,
          path,
        );
      }
      // Native JSON number — small enough that safe-integer range matters.
      // For very large integers, the caller should use `decimal`.
      const asNum = asDecimal.toNumber();
      if (!Number.isSafeInteger(asNum)) {
        throw new CanonicalSerializationError(
          `integer ${asDecimal.toFixed()} exceeds safe integer range; use decimal kind`,
          path,
        );
      }
      return asNum;
    }

    case 'decimal': {
      // TRD §14.4 rule 5: parse via Decimal, reserialize at the declared
      // precision. `"2"`, `2`, `2.0`, `"2.00"` all collapse to e.g. `"2.00"`.
      let parsed: Decimal;
      if (value instanceof Decimal) {
        parsed = value;
      } else if (typeof value === 'string' || typeof value === 'number') {
        try {
          parsed = parseDecimal(value);
        } catch (err) {
          throw new CanonicalSerializationError(
            `failed to parse decimal: ${(err as Error).message}`,
            path,
          );
        }
      } else {
        throw new CanonicalSerializationError(
          `expected decimal-compatible value, got ${typeOf(value)}`,
          path,
        );
      }
      return serializeDecimal(parsed, spec.precision);
    }

    case 'date': {
      // TRD §14.4 rule 4: collapse all representations of a calendar date to
      // YYYY-MM-DD. We anchor in UTC so a Date object that came from a
      // YYYY-MM-DD parse (UTC midnight) round-trips identically.
      const d = coerceToDate(value, path);
      return formatUtcDateOnly(d);
    }

    case 'datetime': {
      // TRD §14.4 rule 4: collapse all representations of an instant to a
      // single ISO-8601 UTC form with milliseconds.
      const d = coerceToDate(value, path);
      return d.toISOString();
    }

    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new CanonicalSerializationError(`expected object, got ${typeOf(value)}`, path);
      }
      const input = value as Record<string, unknown>;
      // TRD §14.4 rule 1: object keys sorted lexicographically.
      // TRD §14.4 rule 8: undeclared fields are dropped.
      // Per ADR-014: declared-but-null/undefined fields are also dropped
      //   so adding optional fields to the spec doesn't invalidate old hashes.
      const out: Record<string, JsonValue> = {};
      const declaredKeys = Object.keys(spec.fields).sort();
      for (const key of declaredKeys) {
        if (!(key in input)) continue;
        const fieldValue = input[key];
        if (fieldValue === undefined || fieldValue === null) continue;
        const childSpec = spec.fields[key];
        if (childSpec === undefined) {
          // Should never happen: declaredKeys came from spec.fields.
          throw new CanonicalSerializationError(`internal: missing spec for ${key}`, path);
        }
        out[key] = normalize(fieldValue, childSpec, path ? `${path}.${key}` : key);
      }
      return out;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        throw new CanonicalSerializationError(`expected array, got ${typeOf(value)}`, path);
      }
      // TRD §14.4 rule 7: array order preserved; elements canonicalized.
      return value.map((el, i) => normalize(el, spec.element, `${path}[${i}]`));
    }
  }
}

function coerceNumericForInteger(value: unknown, path: string): Decimal {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalSerializationError(`expected finite integer, got ${value}`, path);
    }
    return new Decimal(value);
  }
  if (typeof value === 'string') {
    try {
      return parseDecimal(value);
    } catch (err) {
      throw new CanonicalSerializationError(
        `failed to parse integer: ${(err as Error).message}`,
        path,
      );
    }
  }
  throw new CanonicalSerializationError(
    `expected integer-compatible value, got ${typeOf(value)}`,
    path,
  );
}

function coerceToDate(value: unknown, path: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalSerializationError('Date object is Invalid Date', path);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new CanonicalSerializationError(
      `expected ISO-8601 string or Date, got ${typeOf(value)}`,
      path,
    );
  }
  if (!ISO_DATE_RE.test(value) && !ISO_DATETIME_RE.test(value)) {
    throw new CanonicalSerializationError(
      `string is not ISO-8601 date or datetime: ${JSON.stringify(value)}`,
      path,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CanonicalSerializationError(`unparseable date string ${JSON.stringify(value)}`, path);
  }
  return parsed;
}

function formatUtcDateOnly(d: Date): string {
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
