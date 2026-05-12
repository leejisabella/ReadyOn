import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { DATABASE } from '../../infrastructure/persistence/database.token';
import type { RequestState } from './request-state-machine';

export interface TimeOffRequestRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly inputHash: string;
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly units: Decimal;
  readonly state: RequestState;
  readonly hcmTransactionId: string | null;
  readonly provisionalApprovalId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly rejectedReason: string | null;
  readonly rejectedAt: string | null;
  readonly cancelledAt: string | null;
  readonly escalatedAt: string | null;
  readonly escalationReason: string | null;
  readonly hrReviewFlag: boolean;
  readonly hrReviewReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TimeOffRequestRowRaw {
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

const hydrate = (r: TimeOffRequestRowRaw): TimeOffRequestRow => ({
  id: r.id,
  idempotencyKey: r.idempotencyKey,
  inputHash: r.inputHash,
  employeeId: r.employeeId,
  locationId: r.locationId,
  leaveTypeId: r.leaveTypeId,
  startDate: r.startDate,
  endDate: r.endDate,
  units: new Decimal(r.units),
  state: r.state,
  hcmTransactionId: r.hcmTransactionId,
  provisionalApprovalId: r.provisionalApprovalId,
  approvedBy: r.approvedBy,
  approvedAt: r.approvedAt,
  rejectedReason: r.rejectedReason,
  rejectedAt: r.rejectedAt,
  cancelledAt: r.cancelledAt,
  escalatedAt: r.escalatedAt,
  escalationReason: r.escalationReason,
  hrReviewFlag: r.hrReviewFlag === 1,
  hrReviewReason: r.hrReviewReason,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const SELECT_COLUMNS = `
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

export interface InsertRequestArgs {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly inputHash: string;
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly units: Decimal;
  readonly at: string;
}

@Injectable()
export class RequestStore {
  private readonly findStmt: Statement<[string]>;
  private readonly findByIdemStmt: Statement<[string]>;
  private readonly listForEmployeeStmt: Statement<[string]>;
  private readonly insertStmt: Statement;
  private readonly markApprovedStmt: Statement;
  private readonly markRejectedStmt: Statement;
  private readonly markCancelledStmt: Statement;
  private readonly markProvisionallyApprovedStmt: Statement;
  private readonly markApprovedFromProvisionalStmt: Statement;
  private readonly markEscalatedToHrStmt: Statement;
  private readonly markTakenStmt: Statement;
  private readonly markCancellationPendingStmt: Statement;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM time_off_request WHERE id = ?`,
    );
    this.findByIdemStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM time_off_request WHERE idempotency_key = ?`,
    );
    this.listForEmployeeStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM time_off_request
        WHERE employee_id = ?
        ORDER BY created_at DESC`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO time_off_request
              (id, idempotency_key, input_hash, employee_id, location_id, leave_type_id,
               start_date, end_date, units, state, created_at, updated_at)
            VALUES
              (:id, :idempotencyKey, :inputHash, :employeeId, :locationId, :leaveTypeId,
               :startDate, :endDate, :units, 'PENDING_APPROVAL', :at, :at)`,
    );
    this.markApprovedStmt = db.prepare(
      `UPDATE time_off_request
          SET state               = 'APPROVED',
              approved_by         = :approverId,
              approved_at         = :at,
              hcm_transaction_id  = :hcmTransactionId,
              updated_at          = :at
        WHERE id = :id`,
    );
    this.markRejectedStmt = db.prepare(
      `UPDATE time_off_request
          SET state           = 'REJECTED',
              rejected_reason = :reason,
              rejected_at     = :at,
              updated_at      = :at
        WHERE id = :id`,
    );
    this.markCancelledStmt = db.prepare(
      `UPDATE time_off_request
          SET state         = 'CANCELLED',
              cancelled_at  = :at,
              updated_at    = :at
        WHERE id = :id`,
    );
    this.markProvisionallyApprovedStmt = db.prepare(
      `UPDATE time_off_request
          SET state                   = 'PROVISIONALLY_APPROVED',
              provisional_approval_id = :provisionalApprovalId,
              approved_by             = :approverId,
              updated_at              = :at
        WHERE id = :id`,
    );
    this.markApprovedFromProvisionalStmt = db.prepare(
      `UPDATE time_off_request
          SET state               = 'APPROVED',
              approved_at         = :at,
              hcm_transaction_id  = :hcmTransactionId,
              updated_at          = :at
        WHERE id = :id`,
    );
    this.markEscalatedToHrStmt = db.prepare(
      `UPDATE time_off_request
          SET state            = 'ESCALATED_TO_HR',
              escalated_at     = :at,
              escalation_reason = :reason,
              hr_review_flag   = 1,
              hr_review_reason = :reason,
              updated_at       = :at
        WHERE id = :id`,
    );
    this.markTakenStmt = db.prepare(
      `UPDATE time_off_request
          SET state            = 'TAKEN',
              hr_review_flag   = :hrReviewFlag,
              hr_review_reason = :hrReviewReason,
              updated_at       = :at
        WHERE id = :id`,
    );
    this.markCancellationPendingStmt = db.prepare(
      `UPDATE time_off_request
          SET state      = 'CANCELLATION_PENDING',
              updated_at = :at
        WHERE id = :id`,
    );
  }

  find(id: string): TimeOffRequestRow | null {
    const row = this.findStmt.get(id) as TimeOffRequestRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  findByIdempotencyKey(key: string): TimeOffRequestRow | null {
    const row = this.findByIdemStmt.get(key) as TimeOffRequestRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * Returns the employee's requests newest-first. When `states` is provided,
   * filters to that set; otherwise returns every row.
   */
  listForEmployee(
    employeeId: string,
    states: ReadonlyArray<RequestState> | null = null,
  ): TimeOffRequestRow[] {
    const rows = this.listForEmployeeStmt.all(employeeId) as TimeOffRequestRowRaw[];
    const filtered = states === null ? rows : rows.filter((r) => states.includes(r.state));
    return filtered.map(hydrate);
  }

  insertPending(args: InsertRequestArgs): void {
    this.insertStmt.run({
      id: args.id,
      idempotencyKey: args.idempotencyKey,
      inputHash: args.inputHash,
      employeeId: args.employeeId,
      locationId: args.locationId,
      leaveTypeId: args.leaveTypeId,
      startDate: args.startDate,
      endDate: args.endDate,
      units: args.units.toFixed(),
      at: args.at,
    });
  }

  markApproved(args: {
    readonly id: string;
    readonly approverId: string;
    readonly hcmTransactionId: string;
    readonly at: string;
  }): void {
    this.markApprovedStmt.run(args);
  }

  markRejected(args: {
    readonly id: string;
    readonly reason: string;
    readonly at: string;
  }): void {
    this.markRejectedStmt.run(args);
  }

  markCancelled(args: { readonly id: string; readonly at: string }): void {
    this.markCancelledStmt.run(args);
  }

  markProvisionallyApproved(args: {
    readonly id: string;
    readonly provisionalApprovalId: string;
    readonly approverId: string;
    readonly at: string;
  }): void {
    this.markProvisionallyApprovedStmt.run(args);
  }

  /**
   * Promote a `PROVISIONALLY_APPROVED` request to `APPROVED` after the
   * reconciler has confirmed the HCM debit. `approved_by` is preserved from
   * the break-glass step; only `approved_at` and `hcm_transaction_id` are set.
   */
  markApprovedFromProvisional(args: {
    readonly id: string;
    readonly hcmTransactionId: string;
    readonly at: string;
  }): void {
    this.markApprovedFromProvisionalStmt.run(args);
  }

  markEscalatedToHr(args: {
    readonly id: string;
    readonly reason: string;
    readonly at: string;
  }): void {
    this.markEscalatedToHrStmt.run(args);
  }

  /**
   * Terminal transition for a request whose `endDate` already passed by the
   * time the reconciler ran (TRD §9.5.5). Sets `hr_review_flag` according to
   * whether HCM accepted or rejected.
   */
  markTaken(args: {
    readonly id: string;
    readonly hrReviewFlag: boolean;
    readonly hrReviewReason: string | null;
    readonly at: string;
  }): void {
    this.markTakenStmt.run({
      id: args.id,
      hrReviewFlag: args.hrReviewFlag ? 1 : 0,
      hrReviewReason: args.hrReviewReason,
      at: args.at,
    });
  }

  /**
   * Transition `APPROVED` or `PROVISIONALLY_APPROVED` → `CANCELLATION_PENDING`.
   * The terminal `CANCELLED` transition is driven by the reconciler once HCM
   * confirms the credit (TRD §9.5.4).
   */
  markCancellationPending(args: { readonly id: string; readonly at: string }): void {
    this.markCancellationPendingStmt.run(args);
  }
}
