import { Field, ID, ObjectType } from '@nestjs/graphql';
import Decimal from 'decimal.js';
import { DateTime } from "../scalars/date-time.scalar";
import { IsoDate } from "../scalars/iso-date.scalar";
import { RequestState } from '../enums';

/**
 * GraphQL projection of `time_off_request`. Read-only — every transition is
 * driven through a mutation. Field names follow the TRD §7.1 contract.
 */
@ObjectType('TimeOffRequest', { description: 'A time-off request and its current lifecycle state.' })
export class TimeOffRequestType {
  @Field(() => ID) readonly id!: string;
  @Field(() => String) readonly employeeId!: string;
  @Field(() => String) readonly locationId!: string;
  @Field(() => String) readonly leaveTypeId!: string;
  @Field(() => IsoDate) readonly startDate!: string;
  @Field(() => IsoDate) readonly endDate!: string;
  @Field(() => Decimal) readonly units!: Decimal;
  @Field(() => RequestState) readonly state!: RequestState;
  @Field(() => ID, { nullable: true }) readonly hcmTransactionId!: string | null;
  @Field(() => ID, { nullable: true }) readonly provisionalApprovalId!: string | null;
  @Field(() => String, { nullable: true }) readonly approvedBy!: string | null;
  @Field(() => DateTime, { nullable: true }) readonly approvedAt!: string | null;
  @Field(() => String, { nullable: true }) readonly rejectedReason!: string | null;
  @Field(() => DateTime, { nullable: true }) readonly rejectedAt!: string | null;
  @Field(() => DateTime, { nullable: true }) readonly cancelledAt!: string | null;
  @Field(() => DateTime, { nullable: true }) readonly escalatedAt!: string | null;
  @Field(() => String, { nullable: true }) readonly escalationReason!: string | null;
  @Field(() => Boolean) readonly hrReviewFlag!: boolean;
  @Field(() => String, { nullable: true }) readonly hrReviewReason!: string | null;
  @Field(() => DateTime) readonly createdAt!: string;
  @Field(() => DateTime) readonly updatedAt!: string;
}

/** Standard success envelope for every request-lifecycle mutation. */
@ObjectType('TimeOffRequestPayload', { description: 'Result envelope returned by every TimeOffRequest mutation.' })
export class TimeOffRequestPayload {
  @Field(() => TimeOffRequestType) readonly request!: TimeOffRequestType;
}
