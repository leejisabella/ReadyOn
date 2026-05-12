import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { DomainError, ERROR_CODE_METADATA, type ErrorCode } from '@time-off/domain-types';
import { GraphQLError } from 'graphql';

/**
 * Translates a {@link DomainError} thrown inside a resolver into a
 * `GraphQLError` whose `extensions.code` is the canonical error taxonomy
 * (TRD §14.6). Tools like Apollo Studio surface `code` as a first-class
 * concept; clients can branch on it without parsing messages.
 *
 * Non-DomainError exceptions fall through to NestJS' default handling so
 * unexpected bugs aren't silently coerced into client-friendly errors.
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter<DomainError> {
  catch(exception: DomainError, _host: ArgumentsHost): GraphQLError {
    const meta = ERROR_CODE_METADATA[exception.code as ErrorCode];
    return new GraphQLError(exception.message, {
      extensions: {
        code: exception.code,
        retryable: meta?.retryable ?? 'no',
        details: exception.details ?? undefined,
      },
    });
  }
}
