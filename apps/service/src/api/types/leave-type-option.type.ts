import { Field, ID, ObjectType } from '@nestjs/graphql';
import { IsoDate } from "../scalars/iso-date.scalar";

@ObjectType('LeaveTypeOption', { description: 'Leave type whose availability covers an as-of date at a location.' })
export class LeaveTypeOptionType {
  @Field(() => ID) readonly leaveTypeId!: string;
  @Field(() => ID) readonly locationId!: string;
  @Field(() => Boolean) readonly isActive!: boolean;
  @Field(() => IsoDate) readonly effectiveFrom!: string;
  @Field(() => IsoDate, { nullable: true }) readonly effectiveTo!: string | null;
}
