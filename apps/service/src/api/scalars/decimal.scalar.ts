import { CustomScalar, Scalar } from '@nestjs/graphql';
import { parseDecimal } from '@time-off/decimal-scalar';
import Decimal from 'decimal.js';
import { GraphQLError, Kind, type ValueNode } from 'graphql';

/**
 * GraphQL `Decimal` scalar — strings on the wire, `Decimal` in code.
 *
 * Both directions go through `parseDecimal` so the canonical-form contract
 * (no exponent, no trailing zeros, etc.) is enforced at the boundary. This
 * matches the same parser used for HCM wire payloads.
 *
 * @ref docs/01_TRD.md §7.1, §14.5, ADR-013
 */
@Scalar('Decimal', () => Decimal)
export class DecimalScalar implements CustomScalar<string, Decimal> {
  readonly description = 'Arbitrary-precision decimal, serialized as a string.';

  parseValue(value: unknown): Decimal {
    if (typeof value !== 'string') {
      throw new GraphQLError(`Decimal must be a string, received ${typeof value}`);
    }
    try {
      return parseDecimal(value);
    } catch (err) {
      throw new GraphQLError(`Decimal: ${(err as Error).message}`);
    }
  }

  serialize(value: unknown): string {
    if (value instanceof Decimal) return value.toFixed();
    if (typeof value === 'string') return parseDecimal(value).toFixed();
    throw new GraphQLError(`Decimal: cannot serialize ${typeof value}`);
  }

  parseLiteral(ast: ValueNode): Decimal {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(`Decimal literal must be a string, got ${ast.kind}`);
    }
    return this.parseValue(ast.value);
  }
}
