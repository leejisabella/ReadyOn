import { Field, Int, ObjectType } from '@nestjs/graphql';
import { ReconciliationJobKind } from '../enums';

@ObjectType('ReconciliationJob', { description: 'Result of a triggered reconciliation tick.' })
export class ReconciliationJobType {
  @Field(() => ReconciliationJobKind) readonly kind!: ReconciliationJobKind;
  @Field(() => Int) readonly inspected!: number;
  @Field(() => Int) readonly applied!: number;
  @Field(() => Int) readonly skipped!: number;
}
