import Decimal from 'decimal.js';
import { Kind } from 'graphql';
import { DecimalScalar } from './decimal-scalar';

describe('DecimalScalar (GraphQL boundary)', () => {
  describe('serialize (resolver → wire)', () => {
    it('serializes a Decimal to fixed-notation string', () => {
      expect(DecimalScalar.serialize(new Decimal('2.50'))).toBe('2.5');
      expect(DecimalScalar.serialize(new Decimal('0.0001'))).toBe('0.0001');
    });

    it('accepts pre-stringified values from upstream code', () => {
      expect(DecimalScalar.serialize('2.5')).toBe('2.5');
    });

    it('accepts number inputs but normalizes via Decimal', () => {
      expect(DecimalScalar.serialize(2.5)).toBe('2.5');
    });

    it('throws for objects, booleans, null, undefined', () => {
      expect(() => DecimalScalar.serialize({})).toThrow(TypeError);
      expect(() => DecimalScalar.serialize(true)).toThrow(TypeError);
      expect(() => DecimalScalar.serialize(null)).toThrow(TypeError);
      expect(() => DecimalScalar.serialize(undefined)).toThrow(TypeError);
    });

    it('refuses non-finite numbers', () => {
      expect(() => DecimalScalar.serialize(NaN)).toThrow(RangeError);
      expect(() => DecimalScalar.serialize(Infinity)).toThrow(RangeError);
    });
  });

  describe('parseValue (variable → resolver)', () => {
    it('parses a string variable into a Decimal', () => {
      const d = DecimalScalar.parseValue('3.14');
      expect(d).toBeInstanceOf(Decimal);
      expect((d as Decimal).toFixed()).toBe('3.14');
    });

    it('rejects number inputs at the GraphQL boundary (TRD §14.5)', () => {
      expect(() => DecimalScalar.parseValue(3.14)).toThrow(TypeError);
    });

    it('rejects non-string values', () => {
      expect(() => DecimalScalar.parseValue(null)).toThrow(TypeError);
      expect(() => DecimalScalar.parseValue(undefined)).toThrow(TypeError);
      expect(() => DecimalScalar.parseValue({})).toThrow(TypeError);
    });

    it('rejects malformed decimal strings', () => {
      expect(() => DecimalScalar.parseValue('1e3')).toThrow(RangeError);
      expect(() => DecimalScalar.parseValue(' 1.5')).toThrow(RangeError);
    });
  });

  describe('parseLiteral (inline literal → resolver)', () => {
    it('parses a STRING literal into a Decimal', () => {
      const d = DecimalScalar.parseLiteral({ kind: Kind.STRING, value: '0.5' });
      expect(d).toBeInstanceOf(Decimal);
      expect((d as Decimal).toFixed()).toBe('0.5');
    });

    it('rejects non-STRING literals (INT, FLOAT, etc.)', () => {
      expect(() => DecimalScalar.parseLiteral({ kind: Kind.INT, value: '2' })).toThrow(TypeError);
      expect(() => DecimalScalar.parseLiteral({ kind: Kind.FLOAT, value: '2.5' })).toThrow(TypeError);
      expect(() => DecimalScalar.parseLiteral({ kind: Kind.BOOLEAN, value: true })).toThrow(TypeError);
    });
  });

  describe('contract', () => {
    it('is named "Decimal" so it is referenced consistently across the GraphQL schema', () => {
      expect(DecimalScalar.name).toBe('Decimal');
    });

    it('has a description (clients introspect to learn the contract)', () => {
      expect(DecimalScalar.description).toMatch(/decimal/i);
    });

    it('round-trips string → parseValue → serialize unchanged', () => {
      const inputs = ['0', '1', '2.5', '-3.14', '0.0001', '999999.99'];
      for (const s of inputs) {
        const parsed = DecimalScalar.parseValue(s) as Decimal;
        expect(DecimalScalar.serialize(parsed)).toBe(s);
      }
    });
  });
});
