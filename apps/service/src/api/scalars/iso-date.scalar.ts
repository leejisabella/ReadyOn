import { CustomScalar, Scalar } from '@nestjs/graphql';
import { GraphQLError, Kind, type ValueNode } from 'graphql';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sentinel class used as the JS-side type for the `Date` scalar. See
 * {@link DateTime} for the same pattern with timestamps.
 */
export abstract class IsoDate {
  private constructor() {
    // tag-only — never instantiated
  }
}

/**
 * ISO-8601 calendar date with no time component (YYYY-MM-DD). Used for
 * `startDate` / `endDate` / `effectiveFrom` / `effectiveTo`.
 *
 * @ref docs/01_TRD.md §7.1
 */
@Scalar('Date', () => IsoDate)
export class IsoDateScalar implements CustomScalar<string, string> {
  readonly description = 'ISO-8601 calendar date (YYYY-MM-DD), no time component.';

  parseValue(value: unknown): string {
    if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
      throw new GraphQLError('Date must be YYYY-MM-DD');
    }
    return value;
  }

  serialize(value: unknown): string {
    if (typeof value === 'string' && ISO_DATE_RE.test(value)) return value;
    throw new GraphQLError(`Date: cannot serialize ${typeof value}`);
  }

  parseLiteral(ast: ValueNode): string {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError('Date literal must be a string');
    }
    return this.parseValue(ast.value);
  }
}
