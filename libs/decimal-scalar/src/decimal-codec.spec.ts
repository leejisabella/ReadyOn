import Decimal from 'decimal.js';
import { parseDecimal, serializeDecimal, formatDecimalNatural } from './decimal-codec';

describe('parseDecimal', () => {
  it.each([
    ['0', '0'],
    ['1', '1'],
    ['1.5', '1.5'],
    ['-1.5', '-1.5'],
    ['100.001', '100.001'],
    ['0.001', '0.001'],
  ])('accepts strict string %s', (input, expected) => {
    expect(parseDecimal(input).toFixed()).toBe(expected);
  });

  it.each([
    [0, '0'],
    [1, '1'],
    [2.5, '2.5'],
    [-3, '-3'],
  ])('accepts number %s', (input, expected) => {
    expect(parseDecimal(input).toFixed()).toBe(expected);
  });

  it.each([
    '1.',
    '.5',
    '01',
    '1e3',
    ' 1.5',
    '1.5 ',
    '+1.5',
    '1,000.00',
    '0x10',
    'NaN',
    'Infinity',
    '',
  ])('rejects malformed string %j', (input) => {
    expect(() => parseDecimal(input)).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite number %s', (input) => {
    expect(() => parseDecimal(input)).toThrow(RangeError);
  });

  it.each([{}, [], true, null, undefined])('rejects non-string/non-number %j', (input) => {
    // @ts-expect-error — runtime guard test
    expect(() => parseDecimal(input)).toThrow(TypeError);
  });
});

describe('serializeDecimal', () => {
  it('pads to the requested precision with trailing zeros', () => {
    expect(serializeDecimal(new Decimal('2'), 2)).toBe('2.00');
    expect(serializeDecimal(new Decimal('2.5'), 2)).toBe('2.50');
    expect(serializeDecimal(new Decimal('0.5'), 2)).toBe('0.50');
  });

  it('truncates/rounds when input has more precision than requested', () => {
    expect(serializeDecimal(new Decimal('2.345'), 2)).toBe('2.35'); // ROUND_HALF_UP default
  });

  it('supports precision 0 (integer string)', () => {
    expect(serializeDecimal(new Decimal('2'), 0)).toBe('2');
    expect(serializeDecimal(new Decimal('2.6'), 0)).toBe('3');
  });

  it('preserves the sign', () => {
    expect(serializeDecimal(new Decimal('-2.5'), 2)).toBe('-2.50');
  });

  it.each([-1, 1.5, NaN, Infinity])('rejects invalid precision %s', (p) => {
    expect(() => serializeDecimal(new Decimal('1'), p)).toThrow(RangeError);
  });
});

describe('formatDecimalNatural', () => {
  it('returns fixed-point notation without scientific exponents', () => {
    expect(formatDecimalNatural(new Decimal('0.0000001'))).toBe('0.0000001');
    expect(formatDecimalNatural(new Decimal('100000000000000'))).toBe('100000000000000');
  });

  it('preserves significant digits supplied at construction', () => {
    expect(formatDecimalNatural(new Decimal('2.50'))).toBe('2.5'); // toFixed() trims trailing zeros
    expect(formatDecimalNatural(new Decimal('2.500001'))).toBe('2.500001');
  });

  it('round-trips through parseDecimal for typical values', () => {
    for (const s of ['0', '1', '2.5', '-3.14', '0.0001', '999999.99']) {
      expect(formatDecimalNatural(parseDecimal(s))).toBe(s);
    }
  });
});
