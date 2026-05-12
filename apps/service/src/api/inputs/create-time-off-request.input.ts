import { Field, ID, InputType } from '@nestjs/graphql';
import Decimal from 'decimal.js';
import { IsoDate } from "../scalars/iso-date.scalar";

@InputType('CreateTimeOffRequestInput', {
  description: 'Input to `createTimeOffRequest`. Dates are inclusive (TRD §9.1).',
})
export class CreateTimeOffRequestInputType {
  @Field(() => ID) readonly employeeId!: string;
  @Field(() => ID) readonly leaveTypeId!: string;
  @Field(() => IsoDate) readonly startDate!: string;
  @Field(() => IsoDate) readonly endDate!: string;
  @Field(() => Decimal) readonly units!: Decimal;
}
