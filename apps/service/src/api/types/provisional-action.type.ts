import { Field, ID, ObjectType } from '@nestjs/graphql';
import type {
  ProvisionalActionType as DomainProvisionalActionType,
  ReconciliationState as DomainReconciliationState,
} from '../../domain/provisional-action/provisional-action.store';
import type { TimeOffRequestRow } from '../../domain/request/request.store';
import type { ReconciliationStepRow } from '../../infrastructure/reconciliation/reconciliation-step.store';
import { ProvisionalActionTypeEnum, ProvisionalReconciliationState } from '../enums';
import { DateTime } from '../scalars/date-time.scalar';
import { ReconciliationStepType } from './reconciliation-step.type';
import { TimeOffRequestType } from './time-off-request.type';

@ObjectType('ProvisionalAction', {
  description: 'A break-glass approval or provisional cancellation in the reconciliation pipeline.',
})
export class ProvisionalActionType {
  @Field(() => ID) readonly id!: string;
  @Field(() => ProvisionalActionTypeEnum) readonly type!: DomainProvisionalActionType;
  @Field(() => ID) readonly requestId!: string;
  @Field(() => ID) readonly invokedBy!: string;
  @Field(() => DateTime) readonly invokedAt!: string;
  @Field(() => String) readonly reason!: string;
  @Field(() => ProvisionalReconciliationState)
  readonly reconciliationState!: DomainReconciliationState;
  @Field(() => DateTime, { nullable: true }) readonly reconciledAt!: string | null;

  // Linked relations resolved by field-resolvers in the resolver module.
  @Field(() => TimeOffRequestType) readonly request!: TimeOffRequestRow;
  @Field(() => [ReconciliationStepType])
  readonly reconciliationSteps!: ReadonlyArray<ReconciliationStepRow>;
}
