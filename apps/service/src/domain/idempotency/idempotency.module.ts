import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyStore } from './idempotency.store';

/**
 * Inbound idempotency cache. Used by every mutating service to short-circuit
 * client retries with the previously-cached response.
 *
 * @ref docs/04_Module_Plan.md §3.8
 */
@Module({
  providers: [IdempotencyStore, IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
