import { Args, ID, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  ProvisionalActionStore,
  type ProvisionalActionRow,
} from '../../domain/provisional-action/provisional-action.store';
import { RequestStore } from '../../domain/request/request.store';
import { ReconciliationStepStore } from '../../infrastructure/reconciliation/reconciliation-step.store';
import { ProvisionalReconciliationState } from '../enums';
import { ProvisionalActionType } from '../types/provisional-action.type';
import { ReconciliationStepType } from '../types/reconciliation-step.type';
import { TimeOffRequestType } from '../types/time-off-request.type';

@Resolver(() => ProvisionalActionType)
export class ProvisionalActionResolver {
  constructor(
    private readonly actions: ProvisionalActionStore,
    private readonly steps: ReconciliationStepStore,
    private readonly requests: RequestStore,
  ) {}

  @Query(() => [ProvisionalActionType], {
    description: 'Provisional actions, optionally filtered by request id or reconciliation state.',
  })
  provisionalActions(
    @Args('requestId', { type: () => ID, nullable: true }) requestId: string | null,
    @Args('reconciliationState', { type: () => ProvisionalReconciliationState, nullable: true })
    reconciliationState: ProvisionalReconciliationState | null,
  ): ProvisionalActionRow[] {
    if (requestId !== null) {
      const rows = this.actions.findByRequestId(requestId);
      return reconciliationState === null
        ? rows
        : rows.filter((r) => r.reconciliationState === reconciliationState);
    }
    return reconciliationState === 'PENDING' ? this.actions.listPending() : [];
  }

  @ResolveField(() => TimeOffRequestType)
  request(@Parent() action: ProvisionalActionRow): TimeOffRequestType {
    const row = this.requests.find(action.requestId);
    if (row === null) {
      throw new Error(`internal: ProvisionalAction ${action.id} references missing request`);
    }
    return row as TimeOffRequestType;
  }

  @ResolveField(() => [ReconciliationStepType])
  reconciliationSteps(@Parent() action: ProvisionalActionRow): ReconciliationStepType[] {
    return this.steps.listForAction(action.id) as ReconciliationStepType[];
  }
}
