import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import type {
  ReconciliationStepKind as DomainReconciliationStepKind,
  ReconciliationStepOutcome as DomainReconciliationStepOutcome,
} from '../../infrastructure/reconciliation/reconciliation-step.store';
import { ReconciliationStepKindEnum, ReconciliationStepOutcomeEnum } from '../enums';
import { DateTime } from '../scalars/date-time.scalar';

@ObjectType('ReconciliationStep', {
  description:
    "Per-step event log entry for a single provisional action's reconciliation. " +
    'Surfaced for HR audit (TRD §5.7).',
})
export class ReconciliationStepType {
  @Field(() => ID) readonly id!: string;
  @Field(() => ID) readonly actionId!: string;
  @Field(() => Int) readonly stepSequence!: number;
  @Field(() => ReconciliationStepKindEnum) readonly kind!: DomainReconciliationStepKind;
  @Field(() => ReconciliationStepOutcomeEnum) readonly outcome!: DomainReconciliationStepOutcome;
  @Field(() => DateTime) readonly occurredAt!: string;
}
