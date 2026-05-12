import { Mutation, Resolver } from '@nestjs/graphql';
import { BatchReconciliation } from '../../infrastructure/reconciliation/batch-reconciliation.service';
import { ProvisionalReconciler } from '../../infrastructure/reconciliation/provisional-reconciler.service';
import { ReconciliationJobKind } from '../enums';
import { ReconciliationJobType } from '../types/reconciliation-job.type';

/**
 * Internal mutations that ops uses to nudge the reconciler cadences when
 * they don't want to wait for the next scheduled tick. Gateway-protected
 * (TRD §7.1 "Internal — protected at gateway").
 */
@Resolver()
export class AdminResolver {
  constructor(
    private readonly batch: BatchReconciliation,
    private readonly provisional: ProvisionalReconciler,
  ) {}

  @Mutation(() => ReconciliationJobType, {
    description: 'Force a batch-reconciliation tick over the HCM corpus.',
  })
  async triggerReconciliation(): Promise<ReconciliationJobType> {
    const result = await this.batch.tick();
    return {
      kind: ReconciliationJobKind.BATCH,
      inspected: result.inspected,
      applied: result.applied,
      skipped: result.skipped,
    };
  }

  @Mutation(() => ReconciliationJobType, {
    description: 'Force a provisional-reconciler tick.',
  })
  async triggerProvisionalReconciliation(): Promise<ReconciliationJobType> {
    const result = await this.provisional.tick();
    return {
      kind: ReconciliationJobKind.PROVISIONAL,
      inspected: result.inspected,
      applied: result.confirmed + result.noOps,
      skipped: result.retryable,
    };
  }
}
