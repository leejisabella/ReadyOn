import { Module } from '@nestjs/common';
import { ProvisionalActionStore } from './provisional-action.store';

/**
 * Append-only event log of every break-glass and provisional-cancellation
 * decision. Consumed by the saga (write) and the provisional reconciler
 * (read + 5-field allow-list update via `markReconciled`).
 *
 * @ref docs/04_Module_Plan.md §3.7
 */
@Module({
  providers: [ProvisionalActionStore],
  exports: [ProvisionalActionStore],
})
export class ProvisionalActionModule {}
