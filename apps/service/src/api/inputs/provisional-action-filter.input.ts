import { Field, ID, InputType } from '@nestjs/graphql';
import { ProvisionalReconciliationState } from '../enums';

/**
 * Filter input for the `provisionalActions` query (TRD §7.1). Every field is
 * optional — passing nothing returns every action; combining fields ANDs them
 * together at the store layer.
 */
@InputType('ProvisionalActionFilter', {
  description: 'Optional filter for the `provisionalActions` query.',
})
export class ProvisionalActionFilterInput {
  @Field(() => ID, { nullable: true }) readonly requestId?: string | null;
  @Field(() => ID, { nullable: true }) readonly invokedBy?: string | null;
  @Field(() => ProvisionalReconciliationState, { nullable: true })
  readonly reconciliationState?: ProvisionalReconciliationState | null;
}
