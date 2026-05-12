import { Field, ID, ObjectType } from '@nestjs/graphql';
import { DateTime } from "../scalars/date-time.scalar";
import { ProvisionalActionTypeEnum, ProvisionalReconciliationState } from '../enums';
import { ReconciliationStepType } from './reconciliation-step.type';
import { TimeOffRequestType } from './time-off-request.type';

@ObjectType('ProvisionalAction', {
  description: 'A break-glass approval or provisional cancellation in the reconciliation pipeline.',
})
export class ProvisionalActionType {
  @Field(() => ID) readonly id!: string;
  @Field(() => ProvisionalActionTypeEnum) readonly type!: ProvisionalActionTypeEnum;
  @Field(() => ID) readonly requestId!: string;
  @Field(() => ID) readonly invokedBy!: string;
  @Field(() => DateTime) readonly invokedAt!: string;
  @Field(() => String) readonly reason!: string;
  @Field(() => ProvisionalReconciliationState)
  readonly reconciliationState!: ProvisionalReconciliationState;
  @Field(() => DateTime, { nullable: true }) readonly reconciledAt!: string | null;

  // Linked relations resolved by field-resolvers in the resolver module.
  @Field(() => TimeOffRequestType) readonly request!: TimeOffRequestType;
  @Field(() => [ReconciliationStepType])
  readonly reconciliationSteps!: ReadonlyArray<ReconciliationStepType>;
}
