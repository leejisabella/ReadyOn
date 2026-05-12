import { Field, ID, ObjectType } from '@nestjs/graphql';
import Decimal from 'decimal.js';
import { DateTime } from "../scalars/date-time.scalar";
import { BalanceState } from '../enums';

@ObjectType('Holds', { description: 'The three hold buckets that bound a balance locally.' })
export class HoldsType {
  @Field(() => Decimal) readonly pending!: Decimal;
  @Field(() => Decimal) readonly approved!: Decimal;
  @Field(() => Decimal) readonly provisional!: Decimal;
}

@ObjectType('Balance', { description: 'Local balance projection keyed by (employee, location, leaveType).' })
export class BalanceType {
  @Field(() => ID) readonly employeeId!: string;
  @Field(() => ID) readonly locationId!: string;
  @Field(() => ID) readonly leaveTypeId!: string;
  @Field(() => Decimal) readonly available!: Decimal;
  @Field(() => HoldsType) readonly holds!: HoldsType;
  @Field(() => String) readonly hcmVersion!: string;
  @Field(() => DateTime) readonly hcmEffectiveAt!: string;
  @Field(() => DateTime) readonly lastReconciledAt!: string;
  @Field(() => BalanceState) readonly state!: BalanceState;
}
