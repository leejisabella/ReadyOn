import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { DATABASE } from '../../infrastructure/persistence/database.token';
import {
  ProvisionalActionStore,
  type ProvisionalActionRow,
} from '../provisional-action/provisional-action.store';
import type { RequestState } from '../request/request-state-machine';
import type { TimeOffRequestRow } from '../request/request.store';

/**
 * The three categories of request that surface in the HR Review Queue
 * (TRD §9.5.5 "HR review surface"). Mapped to GraphQL `HrReviewCategory`
 * in the API layer (Slice 19).
 */
export type HrReviewCategory =
  | 'ESCALATED_PRE_LEAVE'
  | 'ESCALATED_POST_LEAVE'
  | 'CANCELLATION_STUCK';

export interface HrReviewItem {
  readonly request: TimeOffRequestRow;
  readonly category: HrReviewCategory;
  readonly flaggedAt: string;
  readonly reason: string;
  readonly provisionalActions: ReadonlyArray<ProvisionalActionRow>;
}

export interface HrReviewQueueFilter {
  /** If omitted, all three categories are returned. */
  readonly categories?: ReadonlyArray<HrReviewCategory>;
  readonly employeeId?: string;
  readonly locationId?: string;
}

export interface HrReviewQueuePageInput {
  /** Page size. Default 50, clamped to {@link MAX_PAGE_SIZE}. */
  readonly first?: number;
  /** Opaque cursor from the previous page's {@link HrReviewQueuePage.endCursor}. */
  readonly after?: string;
}

export interface HrReviewQueuePage {
  readonly items: ReadonlyArray<HrReviewItem>;
  readonly totalCount: number;
  readonly hasNextPage: boolean;
  readonly startCursor: string | null;
  readonly endCursor: string | null;
}

export interface HrReviewQueueOptions {
  /** TRD §16 `cancellationPendingAlertThresholdMs`. Default 1h. */
  readonly cancellationStuckAfterMs?: number;
  /** Test seam. */
  readonly now?: () => number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
const DEFAULT_CANCELLATION_STUCK_AFTER_MS = 60 * 60 * 1000;

interface QueueRowRaw {
  category: HrReviewCategory;
  flaggedAt: string;
  reason: string;
  // request projection
  id: string;
  idempotencyKey: string;
  inputHash: string;
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  units: string;
  state: RequestState;
  hcmTransactionId: string | null;
  provisionalApprovalId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  hrReviewFlag: 0 | 1;
  hrReviewReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CursorValue {
  readonly flaggedAt: string;
  readonly id: string;
}

const CATEGORY_FRAGMENTS: Readonly<Record<HrReviewCategory, string>> = {
  ESCALATED_PRE_LEAVE: `
    SELECT 'ESCALATED_PRE_LEAVE'  AS category,
           escalated_at           AS flaggedAt,
           COALESCE(hr_review_reason, escalation_reason, 'Escalated to HR') AS reason,
           ${REQUEST_PROJECTION()}
      FROM time_off_request
     WHERE state = 'ESCALATED_TO_HR'
       AND escalated_at IS NOT NULL
  `,
  ESCALATED_POST_LEAVE: `
    SELECT 'ESCALATED_POST_LEAVE' AS category,
           updated_at             AS flaggedAt,
           COALESCE(hr_review_reason, 'Leave taken under provisional approval') AS reason,
           ${REQUEST_PROJECTION()}
      FROM time_off_request
     WHERE state = 'TAKEN' AND hr_review_flag = 1
  `,
  CANCELLATION_STUCK: `
    SELECT 'CANCELLATION_STUCK'   AS category,
           updated_at             AS flaggedAt,
           'Cancellation has not completed within threshold' AS reason,
           ${REQUEST_PROJECTION()}
      FROM time_off_request
     WHERE state = 'CANCELLATION_PENDING'
       AND updated_at < :cancellationStuckCutoff
  `,
};

function REQUEST_PROJECTION(): string {
  return `
           id,
           idempotency_key         AS idempotencyKey,
           input_hash              AS inputHash,
           employee_id             AS employeeId,
           location_id             AS locationId,
           leave_type_id           AS leaveTypeId,
           start_date              AS startDate,
           end_date                AS endDate,
           units,
           state,
           hcm_transaction_id      AS hcmTransactionId,
           provisional_approval_id AS provisionalApprovalId,
           approved_by             AS approvedBy,
           approved_at             AS approvedAt,
           rejected_reason         AS rejectedReason,
           rejected_at             AS rejectedAt,
           cancelled_at            AS cancelledAt,
           escalated_at            AS escalatedAt,
           escalation_reason       AS escalationReason,
           hr_review_flag          AS hrReviewFlag,
           hr_review_reason        AS hrReviewReason,
           created_at              AS createdAt,
           updated_at              AS updatedAt
  `;
}

/**
 * Read projection of `time_off_request` shaped for HR review.
 *
 * Builds one queue from three categories (TRD §9.5.5):
 *   1. `ESCALATED_PRE_LEAVE`  — `state = ESCALATED_TO_HR`, HCM rejected before leave.
 *   2. `ESCALATED_POST_LEAVE` — `state = TAKEN AND hr_review_flag = 1`, rejected after leave.
 *   3. `CANCELLATION_STUCK`   — `state = CANCELLATION_PENDING` older than `cancellationStuckAfterMs`.
 *
 * Cursor pagination follows TRD §7.1 (Q.μ): ordered `flaggedAt DESC, id ASC`,
 * opaque base64-encoded `(flaggedAt, id)` cursor. Each page also carries
 * `totalCount` — the unbounded count is acceptable here because the queue
 * size is bounded by escalation volume (small in practice).
 *
 * @ref docs/01_TRD.md §7.1, §9.5.5, §16 `cancellationPendingAlertThresholdMs`
 * @ref docs/04_Module_Plan.md §3.17
 */
@Injectable()
export class HrReviewQueueService {
  private readonly cancellationStuckAfterMs: number;
  private readonly now: () => number;
  private readonly db: Database;
  private readonly provisionalActions: ProvisionalActionStore;
  /** Reusable totalCount statement keyed by the active query shape. */
  private readonly totalCountCache = new Map<string, Statement>();
  private readonly pageCache = new Map<string, Statement>();

  constructor(
    @Inject(DATABASE) db: Database,
    provisionalActions: ProvisionalActionStore,
    @Inject('HR_REVIEW_QUEUE_OPTIONS') options: HrReviewQueueOptions = {},
  ) {
    this.db = db;
    this.provisionalActions = provisionalActions;
    this.cancellationStuckAfterMs =
      options.cancellationStuckAfterMs ?? DEFAULT_CANCELLATION_STUCK_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  query(
    filter: HrReviewQueueFilter = {},
    page: HrReviewQueuePageInput = {},
  ): HrReviewQueuePage {
    const categories = filter.categories ?? [
      'ESCALATED_PRE_LEAVE',
      'ESCALATED_POST_LEAVE',
      'CANCELLATION_STUCK',
    ];
    if (categories.length === 0) {
      return { items: [], totalCount: 0, hasNextPage: false, startCursor: null, endCursor: null };
    }

    const pageSize = clampPageSize(page.first);
    const cursor = page.after ? decodeCursor(page.after) : null;
    const cancellationStuckCutoff = new Date(
      this.now() - this.cancellationStuckAfterMs,
    ).toISOString();

    const params: Record<string, string | number> = {
      cancellationStuckCutoff,
      employeeId: filter.employeeId ?? '',
      locationId: filter.locationId ?? '',
      limit: pageSize + 1,
      cursorFlaggedAt: cursor?.flaggedAt ?? '',
      cursorId: cursor?.id ?? '',
    };

    const totalCount = this.runTotalCount(categories, filter, params);

    const pageRows = this.runPageQuery(categories, filter, cursor !== null, params);

    const hasNextPage = pageRows.length > pageSize;
    const items = pageRows.slice(0, pageSize).map((row) => this.hydrate(row));
    const startCursor = items[0] ? encodeCursor({ flaggedAt: items[0].flaggedAt, id: items[0].request.id }) : null;
    const endCursor = items[items.length - 1]
      ? encodeCursor({
          flaggedAt: items[items.length - 1]!.flaggedAt,
          id: items[items.length - 1]!.request.id,
        })
      : null;

    return { items, totalCount, hasNextPage, startCursor, endCursor };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private runTotalCount(
    categories: ReadonlyArray<HrReviewCategory>,
    filter: HrReviewQueueFilter,
    params: Record<string, string | number>,
  ): number {
    const sql = this.buildCountSql(categories, filter);
    const stmt = this.cached(this.totalCountCache, sql);
    const row = stmt.get(params) as { total: number };
    return row.total;
  }

  private runPageQuery(
    categories: ReadonlyArray<HrReviewCategory>,
    filter: HrReviewQueueFilter,
    hasCursor: boolean,
    params: Record<string, string | number>,
  ): QueueRowRaw[] {
    const sql = this.buildPageSql(categories, filter, hasCursor);
    const stmt = this.cached(this.pageCache, sql);
    return stmt.all(params) as QueueRowRaw[];
  }

  private buildCountSql(
    categories: ReadonlyArray<HrReviewCategory>,
    filter: HrReviewQueueFilter,
  ): string {
    const inner = this.unionFragments(categories, filter);
    return `SELECT COUNT(*) AS total FROM (${inner}) AS q`;
  }

  private buildPageSql(
    categories: ReadonlyArray<HrReviewCategory>,
    filter: HrReviewQueueFilter,
    hasCursor: boolean,
  ): string {
    const inner = this.unionFragments(categories, filter);
    const where = hasCursor
      ? `WHERE (flaggedAt < :cursorFlaggedAt)
            OR (flaggedAt = :cursorFlaggedAt AND id > :cursorId)`
      : '';
    return `
      SELECT * FROM (${inner}) AS q
      ${where}
      ORDER BY flaggedAt DESC, id ASC
      LIMIT :limit
    `;
  }

  private unionFragments(
    categories: ReadonlyArray<HrReviewCategory>,
    filter: HrReviewQueueFilter,
  ): string {
    const filters: string[] = [];
    if (filter.employeeId !== undefined) filters.push('AND employee_id = :employeeId');
    if (filter.locationId !== undefined) filters.push('AND location_id = :locationId');
    const extra = filters.join(' ');
    return categories
      .map((c) => `${CATEGORY_FRAGMENTS[c]} ${extra}`)
      .join('\nUNION ALL\n');
  }

  private cached(map: Map<string, Statement>, sql: string): Statement {
    let stmt = map.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      map.set(sql, stmt);
    }
    return stmt;
  }

  private hydrate(row: QueueRowRaw): HrReviewItem {
    const request: TimeOffRequestRow = {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      inputHash: row.inputHash,
      employeeId: row.employeeId,
      locationId: row.locationId,
      leaveTypeId: row.leaveTypeId,
      startDate: row.startDate,
      endDate: row.endDate,
      units: new Decimal(row.units),
      state: row.state,
      hcmTransactionId: row.hcmTransactionId,
      provisionalApprovalId: row.provisionalApprovalId,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt,
      rejectedReason: row.rejectedReason,
      rejectedAt: row.rejectedAt,
      cancelledAt: row.cancelledAt,
      escalatedAt: row.escalatedAt,
      escalationReason: row.escalationReason,
      hrReviewFlag: row.hrReviewFlag === 1,
      hrReviewReason: row.hrReviewReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return {
      request,
      category: row.category,
      flaggedAt: row.flaggedAt,
      reason: row.reason,
      provisionalActions: this.provisionalActions.findByRequestId(row.id),
    };
  }
}

// ── Cursor helpers ─────────────────────────────────────────────────────────

function clampPageSize(first: number | undefined): number {
  if (first === undefined || first <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(first, MAX_PAGE_SIZE);
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodeCursor(raw: string): CursorValue | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Partial<CursorValue>;
    if (typeof parsed.flaggedAt === 'string' && typeof parsed.id === 'string') {
      return { flaggedAt: parsed.flaggedAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}
