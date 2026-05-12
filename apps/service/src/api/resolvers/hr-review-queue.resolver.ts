import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';
import {
  HrReviewQueueService,
  type HrReviewItem,
  type HrReviewQueueFilter,
  type HrReviewQueuePage,
} from '../../domain/hr-review-queue/hr-review-queue.service';
import { HrReviewCategoryEnum } from '../enums';
import {
  HrReviewItemConnectionType,
  HrReviewItemEdgeType,
  HrReviewItemType,
  PageInfoType,
} from '../types/hr-review-queue.types';
import type { TimeOffRequestType } from '../types/time-off-request.type';
import type { ProvisionalActionType } from '../types/provisional-action.type';

@Resolver(() => HrReviewItemConnectionType)
export class HrReviewQueueResolver {
  constructor(private readonly hrQueue: HrReviewQueueService) {}

  @Query(() => HrReviewItemConnectionType, {
    description:
      'Paginated queue of requests requiring HR attention. Ordered flaggedAt DESC, id ASC. TRD §7.1, §9.5.5.',
  })
  hrReviewQueue(
    @Args('categories', { type: () => [HrReviewCategoryEnum], nullable: true })
    categories: ReadonlyArray<HrReviewCategoryEnum> | null,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId: string | null,
    @Args('locationId', { type: () => ID, nullable: true }) locationId: string | null,
    @Args('first', { type: () => Int, defaultValue: 50 }) first: number,
    @Args('after', { type: () => String, nullable: true }) after: string | null,
  ): HrReviewItemConnectionType {
    const filter: HrReviewQueueFilter = {
      ...(categories ? { categories } : {}),
      ...(employeeId ? { employeeId } : {}),
      ...(locationId ? { locationId } : {}),
    };
    const page = this.hrQueue.query(filter, { first, after: after ?? undefined });
    return toConnection(page);
  }
}

function toConnection(page: HrReviewQueuePage): HrReviewItemConnectionType {
  const edges: HrReviewItemEdgeType[] = page.items.map((item, idx) => ({
    node: toItem(item),
    // For each item we derive a cursor by base64-encoding `(flaggedAt, id)` —
    // matches the service's `endCursor` encoding so any edge cursor is a
    // valid `after` argument.
    cursor: encodeCursor(item.flaggedAt, item.request.id, idx, page),
  }));
  const pageInfo: PageInfoType = {
    hasNextPage: page.hasNextPage,
    hasPreviousPage: false, // forward pagination only (TRD §7.1, Q.μ)
    startCursor: page.startCursor,
    endCursor: page.endCursor,
  };
  return { edges, pageInfo, totalCount: page.totalCount };
}

function toItem(item: HrReviewItem): HrReviewItemType {
  // ProvisionalAction's `request` and `reconciliationSteps` are populated by
  // field resolvers at query time, so the domain row is structurally
  // compatible only after that pass — cast through `unknown` to acknowledge
  // the intentional gap.
  return {
    request: item.request as TimeOffRequestType,
    category: item.category as HrReviewCategoryEnum,
    flaggedAt: item.flaggedAt,
    reason: item.reason,
    provisionalActions: item.provisionalActions as unknown as ReadonlyArray<ProvisionalActionType>,
  };
}

function encodeCursor(
  flaggedAt: string,
  id: string,
  idx: number,
  page: HrReviewQueuePage,
): string {
  // For the first/last items, reuse the service's cursors so equality holds.
  // For middle items, encode locally.
  if (idx === 0 && page.startCursor !== null) return page.startCursor;
  if (idx === page.items.length - 1 && page.endCursor !== null) return page.endCursor;
  return Buffer.from(JSON.stringify({ flaggedAt, id }), 'utf8').toString('base64');
}
