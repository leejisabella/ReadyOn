import { Field, Int, ObjectType } from '@nestjs/graphql';
import { DateTime } from "../scalars/date-time.scalar";
import { HrReviewCategoryEnum } from '../enums';
import { ProvisionalActionType } from './provisional-action.type';
import { TimeOffRequestType } from './time-off-request.type';

@ObjectType('PageInfo', { description: 'Standard Relay-style PageInfo for cursor pagination.' })
export class PageInfoType {
  @Field(() => Boolean) readonly hasNextPage!: boolean;
  @Field(() => Boolean) readonly hasPreviousPage!: boolean;
  @Field(() => String, { nullable: true }) readonly startCursor!: string | null;
  @Field(() => String, { nullable: true }) readonly endCursor!: string | null;
}

@ObjectType('HrReviewItem', { description: 'A single request flagged for HR review.' })
export class HrReviewItemType {
  @Field(() => TimeOffRequestType) readonly request!: TimeOffRequestType;
  @Field(() => HrReviewCategoryEnum) readonly category!: HrReviewCategoryEnum;
  @Field(() => DateTime) readonly flaggedAt!: string;
  @Field(() => String) readonly reason!: string;
  @Field(() => [ProvisionalActionType])
  readonly provisionalActions!: ReadonlyArray<ProvisionalActionType>;
}

@ObjectType('HrReviewItemEdge')
export class HrReviewItemEdgeType {
  @Field(() => HrReviewItemType) readonly node!: HrReviewItemType;
  @Field(() => String) readonly cursor!: string;
}

@ObjectType('HrReviewItemConnection', { description: 'Paginated HR Review Queue response (TRD §7.1, Q.μ).' })
export class HrReviewItemConnectionType {
  @Field(() => [HrReviewItemEdgeType]) readonly edges!: ReadonlyArray<HrReviewItemEdgeType>;
  @Field(() => PageInfoType) readonly pageInfo!: PageInfoType;
  @Field(() => Int) readonly totalCount!: number;
}
