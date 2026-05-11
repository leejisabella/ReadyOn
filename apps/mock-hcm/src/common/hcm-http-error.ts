import { HttpException } from '@nestjs/common';

/**
 * Uniform 4xx body shape: `{ error, message }` only — no `statusCode` or
 * `error: 'Not Found'` wrapping. This is the contract every HCM error
 * response across the mock obeys; downstream adapters parse one shape, not
 * NestJS's default and a custom one.
 */
export class HcmHttpError extends HttpException {
  constructor(statusCode: number, error: string, message: string) {
    super({ error, message }, statusCode);
  }
}
