import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../../infrastructure/persistence/database.token';

export type ProvisionalActionType = 'BREAK_GLASS_APPROVAL' | 'PROVISIONAL_CANCELLATION';

export type ReconciliationState = 'PENDING' | 'CONFIRMED' | 'REJECTED_ESCALATED' | 'NO_OP';

export interface ProvisionalActionRow {
  readonly id: string;
  readonly type: ProvisionalActionType;
  readonly requestId: string;
  readonly invokedBy: string;
  readonly invokedAt: string;
  readonly reason: string;
  readonly outageStartObservedAt: string;
  readonly localStateSnapshot: Readonly<Record<string, unknown>> | null;
  readonly localStateSnapshotSummary: Readonly<Record<string, unknown>> | null;
  readonly reconciliationState: ReconciliationState;
  readonly reconciledAt: string | null;
  readonly reconciliationDetails: Readonly<Record<string, unknown>> | null;
  readonly lastStaleAlertAt: string | null;
}

interface ProvisionalActionRowRaw {
  id: string;
  type: ProvisionalActionType;
  requestId: string;
  invokedBy: string;
  invokedAt: string;
  reason: string;
  outageStartObservedAt: string;
  localStateSnapshot: string | null;
  localStateSnapshotSummary: string | null;
  reconciliationState: ReconciliationState;
  reconciledAt: string | null;
  reconciliationDetails: string | null;
  lastStaleAlertAt: string | null;
}

const parseJsonOrNull = (s: string | null): Readonly<Record<string, unknown>> | null =>
  s === null ? null : (JSON.parse(s) as Record<string, unknown>);

const hydrate = (r: ProvisionalActionRowRaw): ProvisionalActionRow => ({
  id: r.id,
  type: r.type,
  requestId: r.requestId,
  invokedBy: r.invokedBy,
  invokedAt: r.invokedAt,
  reason: r.reason,
  outageStartObservedAt: r.outageStartObservedAt,
  localStateSnapshot: parseJsonOrNull(r.localStateSnapshot),
  localStateSnapshotSummary: parseJsonOrNull(r.localStateSnapshotSummary),
  reconciliationState: r.reconciliationState,
  reconciledAt: r.reconciledAt,
  reconciliationDetails: parseJsonOrNull(r.reconciliationDetails),
  lastStaleAlertAt: r.lastStaleAlertAt,
});

const SELECT_COLUMNS = `
  id,
  type,
  request_id                     AS requestId,
  invoked_by                     AS invokedBy,
  invoked_at                     AS invokedAt,
  reason,
  outage_start_observed_at       AS outageStartObservedAt,
  local_state_snapshot           AS localStateSnapshot,
  local_state_snapshot_summary   AS localStateSnapshotSummary,
  reconciliation_state           AS reconciliationState,
  reconciled_at                  AS reconciledAt,
  reconciliation_details         AS reconciliationDetails,
  last_stale_alert_at            AS lastStaleAlertAt
`;

export interface InsertProvisionalActionArgs {
  readonly id: string;
  readonly type: ProvisionalActionType;
  readonly requestId: string;
  readonly invokedBy: string;
  readonly invokedAt: string;
  readonly reason: string;
  readonly outageStartObservedAt: string;
  readonly localStateSnapshot: Readonly<Record<string, unknown>>;
}

export interface MarkReconciledArgs {
  readonly id: string;
  readonly reconciliationState: 'CONFIRMED' | 'REJECTED_ESCALATED' | 'NO_OP';
  readonly reconciledAt: string;
  readonly reconciliationDetails: Readonly<Record<string, unknown>>;
  readonly snapshotSummary: Readonly<Record<string, unknown>>;
  /**
   * `true` to null out `local_state_snapshot` (CONFIRMED / NO_OP outcomes).
   * `false` to retain the full snapshot (REJECTED_ESCALATED — HR will read it).
   *
   * @ref docs/02_Assumptions_and_Decisions.md ADR-022
   */
  readonly nullifySnapshot: boolean;
}

/**
 * Append-only repository for break-glass and provisional-cancellation
 * decisions. The five-field allow-list (Rev 3.1, Q.θ) is the only mutation
 * surface — `update` and `delete` are intentionally absent.
 *
 * @ref docs/01_TRD.md §5.6, §5.8
 * @ref docs/02_Assumptions_and_Decisions.md ADR-019, ADR-022
 * @ref docs/04_Module_Plan.md §3.7
 */
@Injectable()
export class ProvisionalActionStore {
  private readonly findStmt: Statement<[string]>;
  private readonly findByRequestStmt: Statement<[string]>;
  private readonly listPendingStmt: Statement<[]>;
  private readonly insertStmt: Statement;
  private readonly markReconciledStmt: Statement;
  private readonly updateStaleAlertStmt: Statement;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM provisional_action WHERE id = ?`,
    );
    this.findByRequestStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM provisional_action
        WHERE request_id = ?
        ORDER BY invoked_at ASC`,
    );
    this.listPendingStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM provisional_action
        WHERE reconciliation_state = 'PENDING'
        ORDER BY invoked_at ASC`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO provisional_action
              (id, type, request_id, invoked_by, invoked_at, reason,
               outage_start_observed_at, local_state_snapshot, reconciliation_state)
            VALUES
              (:id, :type, :requestId, :invokedBy, :invokedAt, :reason,
               :outageStartObservedAt, :localStateSnapshot, 'PENDING')`,
    );
    /*
     * The five-field allow-list per ADR-022 (Rev 3.1, Q.θ). Touching any
     * other column would violate the append-only convention. When
     * append-only triggers are enabled, the database also rejects deviations.
     */
    this.markReconciledStmt = db.prepare(
      `UPDATE provisional_action
          SET reconciliation_state         = :reconciliationState,
              reconciled_at                = :reconciledAt,
              reconciliation_details       = :reconciliationDetails,
              local_state_snapshot         = CASE WHEN :nullifySnapshot = 1
                                                   THEN NULL
                                                   ELSE local_state_snapshot END,
              local_state_snapshot_summary = :snapshotSummary
        WHERE id = :id`,
    );
    this.updateStaleAlertStmt = db.prepare(
      `UPDATE provisional_action SET last_stale_alert_at = :at WHERE id = :id`,
    );
  }

  find(id: string): ProvisionalActionRow | null {
    const row = this.findStmt.get(id) as ProvisionalActionRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  findByRequestId(requestId: string): ProvisionalActionRow[] {
    return (this.findByRequestStmt.all(requestId) as ProvisionalActionRowRaw[]).map(hydrate);
  }

  listPending(): ProvisionalActionRow[] {
    return (this.listPendingStmt.all() as ProvisionalActionRowRaw[]).map(hydrate);
  }

  insert(args: InsertProvisionalActionArgs): void {
    this.insertStmt.run({
      id: args.id,
      type: args.type,
      requestId: args.requestId,
      invokedBy: args.invokedBy,
      invokedAt: args.invokedAt,
      reason: args.reason,
      outageStartObservedAt: args.outageStartObservedAt,
      localStateSnapshot: JSON.stringify(args.localStateSnapshot),
    });
  }

  markReconciled(args: MarkReconciledArgs): void {
    this.markReconciledStmt.run({
      id: args.id,
      reconciliationState: args.reconciliationState,
      reconciledAt: args.reconciledAt,
      reconciliationDetails: JSON.stringify(args.reconciliationDetails),
      snapshotSummary: JSON.stringify(args.snapshotSummary),
      nullifySnapshot: args.nullifySnapshot ? 1 : 0,
    });
  }

  /** Marks the most recent stale-alert emission for deduplication (TRD §9.5.6). */
  recordStaleAlert(id: string, at: string): void {
    this.updateStaleAlertStmt.run({ id, at });
  }
}
