import Decimal from 'decimal.js';
import {
  CanonicalInputSerializer,
  CanonicalSerializationError,
  fk,
  type FieldKind,
} from './canonical-serializer';

const ser = new CanonicalInputSerializer();

// Mirror the CreateTimeOffRequestInput shape so the tests sit close to the
// real first caller.
const requestSpec: FieldKind = fk.object({
  employeeId: fk.string,
  leaveTypeId: fk.string,
  startDate: fk.date,
  endDate: fk.date,
  units: fk.decimal(2),
});

describe('CanonicalInputSerializer — TRD §14.4 rules', () => {
  // ────────── Rule 1: field ordering (T-CAN-01) ──────────
  describe('field ordering', () => {
    it('produces identical hash regardless of JSON field order', () => {
      const a = { employeeId: 'emp-1', units: '2', leaveTypeId: 'pto', startDate: '2025-01-15', endDate: '2025-01-16' };
      const b = { endDate: '2025-01-16', startDate: '2025-01-15', units: '2', leaveTypeId: 'pto', employeeId: 'emp-1' };
      expect(ser.hash(a, requestSpec)).toBe(ser.hash(b, requestSpec));
    });

    it('canonical byte output has keys in lexicographic order', () => {
      const a = { employeeId: 'emp-1', units: '2', leaveTypeId: 'pto', startDate: '2025-01-15', endDate: '2025-01-16' };
      const bytes = ser.canonicalize(a, requestSpec);
      const text = bytes.toString('utf8');
      // Keys must appear in this exact alphabetical order in the serialized JSON.
      expect(text.indexOf('"employeeId"')).toBeLessThan(text.indexOf('"endDate"'));
      expect(text.indexOf('"endDate"')).toBeLessThan(text.indexOf('"leaveTypeId"'));
      expect(text.indexOf('"leaveTypeId"')).toBeLessThan(text.indexOf('"startDate"'));
      expect(text.indexOf('"startDate"')).toBeLessThan(text.indexOf('"units"'));
    });
  });

  // ────────── Rule 2: no whitespace (T-CAN-05) ──────────
  describe('whitespace', () => {
    it('output contains no extra whitespace characters', () => {
      const a = { employeeId: 'emp-1', leaveTypeId: 'pto', startDate: '2025-01-15', endDate: '2025-01-16', units: '2' };
      const text = ser.canonicalize(a, requestSpec).toString('utf8');
      // No spaces, tabs, or newlines outside string contents. Our test strings
      // happen to not contain whitespace, so the strict assertion below holds.
      expect(text).not.toMatch(/[\s]/);
    });
  });

  // ────────── Rule 3: NFC normalization (T-CAN-04) ──────────
  describe('Unicode normalization (NFC)', () => {
    it('treats NFC and NFD spellings of the same string identically', () => {
      const spec = fk.object({ name: fk.string });
      const nfc = { name: 'café' };       // U+00E9 (é as single codepoint)
      const nfd = { name: 'café' };       // U+0065 U+0301 (e + combining acute)
      expect(ser.hash(nfc, spec)).toBe(ser.hash(nfd, spec));
    });

    it('canonical output uses NFC form for string content', () => {
      const spec = fk.object({ name: fk.string });
      const nfd = { name: 'café' };
      const text = ser.canonicalize(nfd, spec).toString('utf8');
      expect(text).toContain('café');
      expect(text).not.toContain('café');
    });
  });

  // ────────── Rule 4: dates (T-CAN-02) ──────────
  describe('date canonicalization', () => {
    it('collapses YYYY-MM-DD and full ISO datetime forms to the same hash for `date` fields', () => {
      const spec = fk.object({ startDate: fk.date });
      const dateOnly = { startDate: '2025-01-15' };
      const dateZ = { startDate: '2025-01-15T00:00:00Z' };
      const dateMs = { startDate: '2025-01-15T00:00:00.000Z' };
      expect(ser.hash(dateOnly, spec)).toBe(ser.hash(dateZ, spec));
      expect(ser.hash(dateOnly, spec)).toBe(ser.hash(dateMs, spec));
    });

    it('canonical date output is exactly YYYY-MM-DD', () => {
      const spec = fk.object({ startDate: fk.date });
      const text = ser.canonicalize({ startDate: '2025-01-15T00:00:00Z' }, spec).toString('utf8');
      expect(text).toContain('"startDate":"2025-01-15"');
    });

    it('accepts Date objects', () => {
      const spec = fk.object({ startDate: fk.date });
      const asString = { startDate: '2025-01-15' };
      const asDate = { startDate: new Date('2025-01-15T00:00:00Z') };
      expect(ser.hash(asString, spec)).toBe(ser.hash(asDate, spec));
    });

    it('datetime canonicalization preserves time-of-day across input formats', () => {
      const spec = fk.object({ when: fk.datetime });
      const a = { when: '2025-01-15T12:34:56Z' };
      const b = { when: '2025-01-15T12:34:56.000Z' };
      expect(ser.hash(a, spec)).toBe(ser.hash(b, spec));
    });

    it('rejects malformed date strings', () => {
      const spec = fk.object({ startDate: fk.date });
      expect(() => ser.canonicalize({ startDate: '2025/01/15' }, spec)).toThrow(CanonicalSerializationError);
      expect(() => ser.canonicalize({ startDate: 'Jan 15 2025' }, spec)).toThrow(CanonicalSerializationError);
    });

    it('rejects datetime strings without timezone designator', () => {
      const spec = fk.object({ when: fk.datetime });
      expect(() => ser.canonicalize({ when: '2025-01-15T12:34:56' }, spec)).toThrow(CanonicalSerializationError);
    });
  });

  // ────────── Rule 5: decimals (T-CAN-03) ──────────
  describe('decimal canonicalization', () => {
    it('collapses all numeric representations of the same value at the declared precision', () => {
      const spec = fk.object({ units: fk.decimal(2) });
      const inputs = [
        { units: 2 },
        { units: 2.0 },
        { units: '2' },
        { units: '2.00' },
      ];
      const hashes = inputs.map((i) => ser.hash(i, spec));
      expect(new Set(hashes).size).toBe(1);
    });

    it('emits trailing zeros to the declared precision', () => {
      const spec = fk.object({ units: fk.decimal(2) });
      const text = ser.canonicalize({ units: 2 }, spec).toString('utf8');
      expect(text).toContain('"units":"2.00"');
    });

    it('rounds when the input has more precision than declared', () => {
      const spec = fk.object({ units: fk.decimal(2) });
      const text = ser.canonicalize({ units: '2.345' }, spec).toString('utf8');
      expect(text).toContain('"units":"2.35"');
    });

    it('accepts Decimal instances directly', () => {
      const spec = fk.object({ units: fk.decimal(2) });
      const a = { units: new Decimal('2.5') };
      const b = { units: '2.50' };
      expect(ser.hash(a, spec)).toBe(ser.hash(b, spec));
    });

    it('distinguishes different decimal values', () => {
      const spec = fk.object({ units: fk.decimal(2) });
      expect(ser.hash({ units: '2.00' }, spec)).not.toBe(ser.hash({ units: '2.01' }, spec));
    });
  });

  // ────────── Rule 6: booleans, nulls (T-CAN-06) ──────────
  describe('booleans and nulls', () => {
    it('serializes booleans as JSON literals (different hash than the string "true")', () => {
      const boolSpec = fk.object({ flag: fk.boolean });
      const strSpec = fk.object({ flag: fk.string });
      const asBool = ser.hash({ flag: true }, boolSpec);
      const asStr = ser.hash({ flag: 'true' }, strSpec);
      expect(asBool).not.toBe(asStr);
    });

    it('rejects boolean spec applied to a string value (catches typos at boundary)', () => {
      const spec = fk.object({ flag: fk.boolean });
      expect(() => ser.canonicalize({ flag: 'true' }, spec)).toThrow(CanonicalSerializationError);
    });

    it('drops declared fields whose value is null or undefined (forward-compat)', () => {
      const spec = fk.object({ a: fk.string, b: fk.string });
      const withBoth = { a: 'x', b: 'y' };
      const withNullB = { a: 'x', b: null };
      const withMissingB = { a: 'x' };
      expect(ser.hash(withNullB, spec)).toBe(ser.hash(withMissingB, spec));
      expect(ser.hash(withBoth, spec)).not.toBe(ser.hash(withNullB, spec));
    });
  });

  // ────────── Rule 7: arrays ──────────
  describe('arrays', () => {
    it('preserves element order (semantic)', () => {
      const spec = fk.object({ tags: fk.array(fk.string) });
      const a = { tags: ['x', 'y', 'z'] };
      const b = { tags: ['z', 'y', 'x'] };
      expect(ser.hash(a, spec)).not.toBe(ser.hash(b, spec));
    });

    it('canonicalizes each element', () => {
      const spec = fk.object({ tags: fk.array(fk.string) });
      const nfc = { tags: ['café'] };
      const nfd = { tags: ['café'] };
      expect(ser.hash(nfc, spec)).toBe(ser.hash(nfd, spec));
    });
  });

  // ────────── Rule 8: unknown fields stripped (T-CAN-07) ──────────
  describe('unknown fields', () => {
    it('drops fields not declared in the spec', () => {
      const spec = fk.object({ employeeId: fk.string });
      const withExtra = { employeeId: 'emp-1', sneaky: 'noise', another: 42 };
      const without = { employeeId: 'emp-1' };
      expect(ser.hash(withExtra, spec)).toBe(ser.hash(without, spec));
    });
  });

  // ────────── Combinations (T-CAN-08) ──────────
  describe('combinations of all rules together', () => {
    it('produces identical hash for inputs differing on every dimension at once', () => {
      const a = {
        units: 2,                                  // numeric decimal
        employeeId: 'emp-1',                       // NFC string
        startDate: '2025-01-15',                   // date-only
        leaveTypeId: 'pto',
        endDate: '2025-01-16T00:00:00Z',           // datetime form
        extraSneaky: 'noise',                      // unknown field
      };
      const b = {
        endDate: '2025-01-16',                     // date-only
        leaveTypeId: 'pto',
        startDate: '2025-01-15T00:00:00.000Z',      // datetime form
        employeeId: 'emp-1',                       // (same content)
        units: '2.00',                             // string decimal at precision
      };
      expect(ser.hash(a, requestSpec)).toBe(ser.hash(b, requestSpec));
    });
  });

  // ────────── Hash properties ──────────
  describe('hash output', () => {
    it('is a 64-char hex SHA-256 digest', () => {
      const hash = ser.hash({ employeeId: 'x', leaveTypeId: 'y', startDate: '2025-01-15', endDate: '2025-01-16', units: '1' }, requestSpec);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('different inputs produce different hashes (no collision in sample set)', () => {
      const a = { employeeId: 'a', leaveTypeId: 'pto', startDate: '2025-01-15', endDate: '2025-01-16', units: '1' };
      const b = { employeeId: 'b', leaveTypeId: 'pto', startDate: '2025-01-15', endDate: '2025-01-16', units: '1' };
      const c = { employeeId: 'a', leaveTypeId: 'pto', startDate: '2025-01-15', endDate: '2025-01-17', units: '1' };
      const d = { employeeId: 'a', leaveTypeId: 'pto', startDate: '2025-01-15', endDate: '2025-01-16', units: '2' };
      const e = { employeeId: 'a', leaveTypeId: 'sick', startDate: '2025-01-15', endDate: '2025-01-16', units: '1' };
      const hashes = [a, b, c, d, e].map((v) => ser.hash(v, requestSpec));
      expect(new Set(hashes).size).toBe(5);
    });
  });

  // ────────── Error paths ──────────
  describe('error paths', () => {
    it('reports the field path on type mismatch', () => {
      const spec = fk.object({ units: fk.decimal(2) });
      try {
        ser.canonicalize({ units: {} }, spec);
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalSerializationError);
        expect((e as CanonicalSerializationError).path).toBe('units');
      }
    });

    it('reports nested array index paths', () => {
      const spec = fk.object({ tags: fk.array(fk.string) });
      try {
        ser.canonicalize({ tags: ['ok', 42] }, spec);
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalSerializationError);
        expect((e as CanonicalSerializationError).path).toBe('tags[1]');
      }
    });

    it('rejects integers outside the safe-integer range', () => {
      const spec = fk.object({ count: fk.integer });
      expect(() =>
        ser.canonicalize({ count: '9007199254740993' }, spec), // 2^53 + 1
      ).toThrow(/safe integer range/);
    });

    it('rejects non-integers in integer slot', () => {
      const spec = fk.object({ count: fk.integer });
      expect(() => ser.canonicalize({ count: 1.5 }, spec)).toThrow(CanonicalSerializationError);
    });
  });
});
