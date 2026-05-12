import { Field, ID, ObjectType } from '@nestjs/graphql';
import Decimal from 'decimal.js';
import type { RequestState as DomainRequestState } from '../../domain/request/request-state-machine';
import type { TimeOffRequestRow } from '../../domain/request/request.store';
import { RequestState } from '../enums';
import { DateTime } from '../scalars/date-time.scalar';
import { IsoDate } from '../scalars/iso-date.scalar';

/**
 * GraphQL projection of `time_off_request` (TRD §7.1). The TS field types
 * mirror {@link TimeOffRequestRow} so domain rows can be returned from
 * resolvers without `as`-casting. The `@Field` decorators describe the GraphQL
 * schema independently of the TS types.
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
  @Field(() => RequestState) readonly state!: DomainRequestState;
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
  @Field(() => TimeOffRequestType) readonly request!: TimeOffRequestRow;
}
