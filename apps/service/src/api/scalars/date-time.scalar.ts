import { CustomScalar, Scalar } from '@nestjs/graphql';
import { GraphQLError, Kind, type ValueNode } from 'graphql';

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Sentinel class used as the JS-side type for the `DateTime` scalar. Field
 * and argument declarations import `DateTime` and write `@Field(() => DateTime)`
 * / `@Args('foo', { type: () => DateTime })`. Domain code continues to pass
 * raw ISO strings — the scalar serializes/parses them.
 */
export abstract class DateTime {
  private constructor() {
    // tag-only — never instantiated
  }
}

/**
 * ISO-8601 instant with explicit timezone — same regex used at the HCM
 * boundary so the service speaks a single timestamp format end-to-end.
 * Values are passed through as strings rather than round-tripped through
 * `Date` to avoid timezone-coercion bugs.
 *
 * @ref docs/01_TRD.md §7.1
 */
@Scalar('DateTime', () => DateTime)
export class DateTimeScalar implements CustomScalar<string, string> {
  readonly description = 'ISO-8601 instant with explicit timezone (e.g., 2026-05-11T12:00:00Z).';

  parseValue(value: unknown): string {
    if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) {
      throw new GraphQLError(`DateTime must be an ISO-8601 timestamp with timezone`);
    }
    return value;
  }

  serialize(value: unknown): string {
    if (typeof value === 'string' && ISO_TIMESTAMP_RE.test(value)) return value;
    if (value instanceof Date) return value.toISOString();
    throw new GraphQLError(`DateTime: cannot serialize ${typeof value}`);
  }

  parseLiteral(ast: ValueNode): string {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError(`DateTime literal must be a string`);
    }
    return this.parseValue(ast.value);
  }
}
