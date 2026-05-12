import { Field, ID, ObjectType } from '@nestjs/graphql';
import { IsoDate } from "../scalars/iso-date.scalar";

@ObjectType('EmploymentPeriod', { description: 'Closed-or-open employment interval at a single location.' })
export class EmploymentPeriodType {
  @Field(() => ID) readonly employeeId!: string;
  @Field(() => ID) readonly locationId!: string;
  @Field(() => IsoDate) readonly effectiveFrom!: string;
  @Field(() => IsoDate, { nullable: true }) readonly effectiveTo!: string | null;
  @Field(() => String) readonly hcmVersion!: string;
}
