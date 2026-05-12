import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { DateTime } from "../scalars/date-time.scalar";
import { ReconciliationStepKindEnum, ReconciliationStepOutcomeEnum } from '../enums';

@ObjectType({
  description:
    "Per-step event log entry for a single provisional action's reconciliation. " +
    'Surfaced for HR audit (TRD §5.7).',
})
export class ReconciliationStepType {
  @Field(() => ID) readonly id!: string;
  @Field(() => ID) readonly actionId!: string;
  @Field(() => Int) readonly stepSequence!: number;
  @Field(() => ReconciliationStepKindEnum) readonly kind!: ReconciliationStepKindEnum;
  @Field(() => ReconciliationStepOutcomeEnum) readonly outcome!: ReconciliationStepOutcomeEnum;
  @Field(() => DateTime) readonly occurredAt!: string;
}
