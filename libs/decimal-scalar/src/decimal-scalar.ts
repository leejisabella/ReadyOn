import Decimal from 'decimal.js';
import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';
import { formatDecimalNatural, parseDecimal } from './decimal-codec';

/**
 * GraphQL custom scalar for `decimal.js` `Decimal` values.
 *
 * Decimals always cross the GraphQL boundary as strings — never numbers — so
 * IEEE-754 float precision never enters the picture. Inputs accepted: string
 * literals, string variables. Outputs: fixed-notation string at the value's
 * natural precision.
 *
 * Domain code that wants a specific precision (e.g., "always two fractional
 * digits") must call {@link serializeDecimal} at the boundary; the scalar
 * itself is precision-agnostic because GraphQL field types don't carry that
 * information.
 *
 * @ref docs/01_TRD.md §14.5
 * @ref docs/02_Assumptions_and_Decisions.md ADR-013
 */
export const DecimalScalar = new GraphQLScalarType<Decimal, string>({
  name: 'Decimal',
  description:
    'Arbitrary-precision decimal. Serialized as a string to avoid JSON-number precision loss; parsed back via decimal.js.',

  serialize(value: unknown): string {
    if (value instanceof Decimal) return formatDecimalNatural(value);
    if (typeof value === 'string' || typeof value === 'number') {
      return formatDecimalNatural(parseDecimal(value));
    }
    throw new TypeError(`Decimal scalar cannot serialize value of type ${typeof value}`);
  },

  parseValue(value: unknown): Decimal {
    if (typeof value !== 'string') {
      throw new TypeError(
        `Decimal scalar must be supplied as a string at the GraphQL boundary; received ${typeof value}`,
      );
    }
    return parseDecimal(value);
  },

  parseLiteral(ast: ValueNode): Decimal {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Decimal literal must be a string, got ${ast.kind}`);
    }
    return parseDecimal(ast.value);
  },
});
