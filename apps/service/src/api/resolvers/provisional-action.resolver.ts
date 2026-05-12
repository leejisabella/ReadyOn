import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  ProvisionalActionStore,
  type ProvisionalActionRow,
} from '../../domain/provisional-action/provisional-action.store';
import { RequestStore, type TimeOffRequestRow } from '../../domain/request/request.store';
import {
  ReconciliationStepStore,
  type ReconciliationStepRow,
} from '../../infrastructure/reconciliation/reconciliation-step.store';
import { ProvisionalActionFilterInput } from '../inputs/provisional-action-filter.input';
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
    description:
      'Provisional actions, optionally filtered by `requestId`, `invokedBy`, or `reconciliationState`.',
  })
  provisionalActions(
    @Args('filter', { type: () => ProvisionalActionFilterInput, nullable: true })
    filter?: ProvisionalActionFilterInput | null,
  ): ProvisionalActionRow[] {
    return this.actions.query(filter ?? {});
  }

  @ResolveField(() => TimeOffRequestType)
  request(@Parent() action: ProvisionalActionRow): TimeOffRequestRow {
    const row = this.requests.find(action.requestId);
    if (row === null) {
      throw new Error(`internal: ProvisionalAction ${action.id} references missing request`);
    }
    return row;
  }

  @ResolveField(() => [ReconciliationStepType])
  reconciliationSteps(@Parent() action: ProvisionalActionRow): ReconciliationStepRow[] {
    return this.steps.listForAction(action.id);
  }
}
