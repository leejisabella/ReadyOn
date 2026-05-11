import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/**
 * NestJS pipe that validates a request payload against a zod schema and
 * surfaces failures as `400 Bad Request`. The pipe is per-route — instantiate
 * with the schema for that route's body, params, or query.
 *
 * @example
 *   @Post('reserve')
 *   reserve(@Body(new ZodPipe(ReserveBodySchema)) body: ReserveBody) { ... }
 */
export class ZodPipe<T extends z.ZodTypeAny> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'INVALID_REQUEST',
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}
