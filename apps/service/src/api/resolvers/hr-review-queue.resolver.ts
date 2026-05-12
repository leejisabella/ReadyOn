import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';
import {
  HrReviewQueueService,
  type HrReviewQueueFilter,
  type HrReviewQueuePage,
} from '../../domain/hr-review-queue/hr-review-queue.service';
import { HrReviewCategoryEnum } from '../enums';
import {
  HrReviewItemConnectionType,
  HrReviewItemEdgeType,
  PageInfoType,
} from '../types/hr-review-queue.types';

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
    return toConnection(this.hrQueue.query(filter, { first, after: after ?? undefined }));
  }
}

function toConnection(page: HrReviewQueuePage): HrReviewItemConnectionType {
  const edges: HrReviewItemEdgeType[] = page.items.map((item, idx) => ({
    // HrReviewItem and HrReviewItemType are structurally identical because the
    // @ObjectType field TS types use domain rows directly — no mapping needed.
    node: item,
    cursor: cursorAt(idx, page),
  }));
  const pageInfo: PageInfoType = {
    hasNextPage: page.hasNextPage,
    hasPreviousPage: false, // forward pagination only (TRD §7.1, Q.μ)
    startCursor: page.startCursor,
    endCursor: page.endCursor,
  };
  return { edges, pageInfo, totalCount: page.totalCount };
}

/**
 * Cursor at position `idx` in the page. Reuses the service's start/end cursors
 * for the first and last items so any returned cursor is a valid `after`
 * argument on the next query.
 */
function cursorAt(idx: number, page: HrReviewQueuePage): string {
  if (idx === 0 && page.startCursor !== null) return page.startCursor;
  if (idx === page.items.length - 1 && page.endCursor !== null) return page.endCursor;
  const item = page.items[idx]!;
  return Buffer.from(JSON.stringify({ flaggedAt: item.flaggedAt, id: item.request.id }), 'utf8').toString('base64');
}
