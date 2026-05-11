import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import {
  ProvisionalActionStore,
  type InsertProvisionalActionArgs,
} from '../provisional-action/provisional-action.store';
import type { RequestState } from '../request/request-state-machine';
import {
  HrReviewQueueService,
  MAX_PAGE_SIZE,
  type HrReviewQueueOptions,
} from './hr-review-queue.service';

interface InsertRequestArgs {
  readonly id: string;
  readonly employeeId?: string;
  readonly locationId?: string;
  readonly leaveTypeId?: string;
  readonly state: RequestState;
  readonly hrReviewFlag?: boolean;
  readonly hrReviewReason?: string | null;
  readonly escalatedAt?: string | null;
  readonly escalationReason?: string | null;
  readonly updatedAt: string;
}

function insertRequest(db: Database, args: InsertRequestArgs): void {
  db.prepare(
    `INSERT INTO time_off_request
        (id, idempotency_key, input_hash, employee_id, location_id, leave_type_id,
         start_date, end_date, units, state,
         escalated_at, escalation_reason, hr_review_flag, hr_review_reason,
         created_at, updated_at)
      VALUES (:id, :idempotencyKey, :inputHash, :employeeId, :locationId, :leaveTypeId,
              '2026-05-15', '2026-05-17', '3', :state,
              :escalatedAt, :escalationReason, :hrReviewFlag, :hrReviewReason,
              :createdAt, :updatedAt)`,
  ).run({
    id: args.id,
    idempotencyKey: `idem-${args.id}`,
    inputHash: `hash-${args.id}`,
    employeeId: args.employeeId ?? 'emp-1',
    locationId: args.locationId ?? 'loc-1',
    leaveTypeId: args.leaveTypeId ?? 'pto',
    state: args.state,
    escalatedAt: args.escalatedAt ?? null,
    escalationReason: args.escalationReason ?? null,
    hrReviewFlag: args.hrReviewFlag ? 1 : 0,
    hrReviewReason: args.hrReviewReason ?? null,
    createdAt: args.updatedAt,
    updatedAt: args.updatedAt,
  });
}

const baseAction = (
  overrides: Partial<InsertProvisionalActionArgs> = {},
): InsertProvisionalActionArgs => ({
  id: 'pa-1',
  type: 'BREAK_GLASS_APPROVAL',
  requestId: 'req-1',
  invokedBy: 'mgr-1',
  invokedAt: '2026-05-11T11:00:00.000Z',
  reason: 'outage',
  outageStartObservedAt: '2026-05-11T10:30:00.000Z',
  localStateSnapshot: { ok: true },
  ...overrides,
});

const NOW_MS = Date.UTC(2026, 4, 11, 13, 0, 0); // 2026-05-11T13:00:00Z

describe('HrReviewQueueService', () => {
  let db: Database;
  let actions: ProvisionalActionStore;
  let service: HrReviewQueueService;

  const buildService = (opts: Partial<HrReviewQueueOptions> = {}): HrReviewQueueService =>
    new HrReviewQueueService(
      db,
      actions,
      { cancellationStuckAfterMs: 60 * 60 * 1000, now: () => NOW_MS, ...opts },
    );

  beforeEach(() => {
    db = makeServiceTestDb();
    actions = new ProvisionalActionStore(db);
    service = buildService();
  });

  afterEach(() => db.close());

  // ── Empty / single-category behaviour ────────────────────────────────────

  it('returns an empty page when no rows match any category', () => {
    expect(service.query()).toEqual({
      items: [],
      totalCount: 0,
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    });
  });

  it('surfaces ESCALATED_PRE_LEAVE rows (state=ESCALATED_TO_HR)', () => {
    insertRequest(db, {
      id: 'req-1',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      escalationReason: 'HCM rejected provisional approval',
      hrReviewFlag: true,
      hrReviewReason: 'HCM rejected provisional approval',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    const page = service.query();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      category: 'ESCALATED_PRE_LEAVE',
      flaggedAt: '2026-05-11T12:00:00.000Z',
      reason: 'HCM rejected provisional approval',
    });
    expect(page.totalCount).toBe(1);
  });

  it('surfaces ESCALATED_POST_LEAVE rows (state=TAKEN, hr_review_flag=1)', () => {
    insertRequest(db, {
      id: 'req-1',
      state: 'TAKEN',
      hrReviewFlag: true,
      hrReviewReason: 'Leave taken under provisional approval; HCM rejected',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    const page = service.query();
    expect(page.items[0]).toMatchObject({
      category: 'ESCALATED_POST_LEAVE',
      reason: 'Leave taken under provisional approval; HCM rejected',
    });
  });

  it('omits TAKEN rows without the hr_review_flag', () => {
    insertRequest(db, {
      id: 'req-1',
      state: 'TAKEN',
      hrReviewFlag: false,
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    expect(service.query().items).toHaveLength(0);
  });

  // ── CANCELLATION_STUCK threshold ─────────────────────────────────────────

  it('surfaces CANCELLATION_STUCK rows older than the threshold', () => {
    insertRequest(db, {
      id: 'req-stuck',
      state: 'CANCELLATION_PENDING',
      updatedAt: '2026-05-11T11:30:00.000Z', // 1.5h ago; threshold is 1h
    });
    insertRequest(db, {
      id: 'req-fresh',
      state: 'CANCELLATION_PENDING',
      updatedAt: '2026-05-11T12:55:00.000Z', // 5 min ago — under threshold
    });
    const page = service.query();
    expect(page.items.map((i) => i.request.id)).toEqual(['req-stuck']);
    expect(page.items[0]?.category).toBe('CANCELLATION_STUCK');
  });

  // ── Mixed categories — ordering ──────────────────────────────────────────

  it('returns rows from all three categories ordered by flaggedAt DESC, id ASC', () => {
    insertRequest(db, {
      id: 'req-A-pre',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:10:00.000Z',
      updatedAt: '2026-05-11T12:10:00.000Z',
      hrReviewFlag: true,
    });
    insertRequest(db, {
      id: 'req-B-post',
      state: 'TAKEN',
      hrReviewFlag: true,
      updatedAt: '2026-05-11T12:30:00.000Z',
    });
    insertRequest(db, {
      id: 'req-C-stuck',
      state: 'CANCELLATION_PENDING',
      updatedAt: '2026-05-11T11:00:00.000Z',
    });
    // Tie at flaggedAt 12:10:00 — secondary sort by id ASC
    insertRequest(db, {
      id: 'req-A-tie',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:10:00.000Z',
      updatedAt: '2026-05-11T12:10:00.000Z',
      hrReviewFlag: true,
    });
    const page = service.query();
    expect(page.items.map((i) => i.request.id)).toEqual([
      'req-B-post', // 12:30
      'req-A-pre', // 12:10  (id ascending wins ties)
      'req-A-tie', // 12:10
      'req-C-stuck', // 11:00
    ]);
  });

  // ── Filtering ────────────────────────────────────────────────────────────

  it('filters to a single category when requested', () => {
    insertRequest(db, {
      id: 'req-pre',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    insertRequest(db, {
      id: 'req-post',
      state: 'TAKEN',
      hrReviewFlag: true,
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    const page = service.query({ categories: ['ESCALATED_POST_LEAVE'] });
    expect(page.items.map((i) => i.request.id)).toEqual(['req-post']);
  });

  it('returns an empty page for an empty categories array', () => {
    insertRequest(db, {
      id: 'req-1',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    expect(service.query({ categories: [] })).toEqual({
      items: [],
      totalCount: 0,
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    });
  });

  it('filters by employeeId and locationId', () => {
    insertRequest(db, {
      id: 'req-emp-A-loc-1',
      employeeId: 'emp-A',
      locationId: 'loc-1',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    insertRequest(db, {
      id: 'req-emp-B-loc-2',
      employeeId: 'emp-B',
      locationId: 'loc-2',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:01:00.000Z',
      updatedAt: '2026-05-11T12:01:00.000Z',
    });
    expect(
      service.query({ employeeId: 'emp-A' }).items.map((i) => i.request.id),
    ).toEqual(['req-emp-A-loc-1']);
    expect(
      service.query({ locationId: 'loc-2' }).items.map((i) => i.request.id),
    ).toEqual(['req-emp-B-loc-2']);
  });

  // ── Linked provisional actions ───────────────────────────────────────────

  it('attaches every linked ProvisionalAction to each item', () => {
    insertRequest(db, {
      id: 'req-1',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    actions.insert(baseAction({ id: 'pa-early', requestId: 'req-1', invokedAt: '2026-05-11T10:00:00.000Z' }));
    actions.insert(baseAction({ id: 'pa-late', requestId: 'req-1', invokedAt: '2026-05-11T11:30:00.000Z' }));
    const page = service.query();
    expect(page.items[0]?.provisionalActions.map((a) => a.id)).toEqual([
      'pa-early',
      'pa-late',
    ]);
  });

  // ── Pagination ───────────────────────────────────────────────────────────

  it('paginates: first page sets hasNextPage and second page resumes after the cursor', () => {
    for (let i = 0; i < 5; i += 1) {
      insertRequest(db, {
        id: `req-${i.toString().padStart(2, '0')}`,
        state: 'ESCALATED_TO_HR',
        escalatedAt: `2026-05-11T12:0${i}:00.000Z`,
        updatedAt: `2026-05-11T12:0${i}:00.000Z`,
      });
    }
    const firstPage = service.query({}, { first: 2 });
    expect(firstPage.items.map((i) => i.request.id)).toEqual(['req-04', 'req-03']);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.totalCount).toBe(5);

    const secondPage = service.query({}, { first: 2, after: firstPage.endCursor! });
    expect(secondPage.items.map((i) => i.request.id)).toEqual(['req-02', 'req-01']);
    expect(secondPage.hasNextPage).toBe(true);

    const thirdPage = service.query({}, { first: 2, after: secondPage.endCursor! });
    expect(thirdPage.items.map((i) => i.request.id)).toEqual(['req-00']);
    expect(thirdPage.hasNextPage).toBe(false);
  });

  it('clamps page size to MAX_PAGE_SIZE', () => {
    insertRequest(db, {
      id: 'req-1',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    // Asking for a huge page is silently clamped; functional test is that
    // the call succeeds and returns the row (no SQL error).
    const page = service.query({}, { first: MAX_PAGE_SIZE + 50 });
    expect(page.items).toHaveLength(1);
  });

  it('treats a malformed cursor as no cursor (first page)', () => {
    insertRequest(db, {
      id: 'req-1',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    expect(service.query({}, { after: 'not-base64-json' }).items).toHaveLength(1);
  });

  it('endCursor round-trips: passing it back as `after` advances exactly past that item', () => {
    insertRequest(db, {
      id: 'req-1',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    insertRequest(db, {
      id: 'req-2',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T11:00:00.000Z',
      updatedAt: '2026-05-11T11:00:00.000Z',
    });
    const firstPage = service.query({}, { first: 1 });
    expect(firstPage.items[0]?.request.id).toBe('req-1');
    const secondPage = service.query({}, { first: 1, after: firstPage.endCursor! });
    expect(secondPage.items[0]?.request.id).toBe('req-2');
  });

  // ── totalCount independence from pagination ──────────────────────────────

  it('totalCount counts all matching rows even when the page is smaller', () => {
    for (let i = 0; i < 3; i += 1) {
      insertRequest(db, {
        id: `req-${i}`,
        state: 'ESCALATED_TO_HR',
        escalatedAt: `2026-05-11T12:0${i}:00.000Z`,
        updatedAt: `2026-05-11T12:0${i}:00.000Z`,
      });
    }
    const page = service.query({}, { first: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.totalCount).toBe(3);
  });

  it('totalCount respects category and employee filters', () => {
    insertRequest(db, {
      id: 'req-emp-A',
      employeeId: 'emp-A',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    });
    insertRequest(db, {
      id: 'req-emp-B',
      employeeId: 'emp-B',
      state: 'ESCALATED_TO_HR',
      escalatedAt: '2026-05-11T12:01:00.000Z',
      updatedAt: '2026-05-11T12:01:00.000Z',
    });
    expect(service.query({ employeeId: 'emp-A' }).totalCount).toBe(1);
  });
});
