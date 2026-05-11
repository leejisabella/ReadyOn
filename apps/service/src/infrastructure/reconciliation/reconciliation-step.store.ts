import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../persistence/database.token';

/**
 * Per-step event log for the provisional reconciler (TRD §5.7, Q.γ).
 *
 * Append-only. `outcome` is the discriminator the algorithm reads to decide
 * whether an action is resumable (`PARTIAL`) or already done (`TERMINAL`).
 * `step_sequence` is monotonic per `action_id`, assigned by the store on
 * insert so callers don't have to track it.
 *
 * @ref docs/01_TRD.md §5.7, §9.5.3
 */

export type ReconciliationStepKind =
  | 'HCM_HISTORY_QUERIED'
  | 'HCM_HISTORY_QUERY_FAILED'
  | 'HISTORY_MISMATCH'
  | 'HCM_CALL_IN_FLIGHT'
  | 'OUTCOME_APPLIED'
  | 'OUTCOME_INVALID'
  | 'PAIR_COALESCED'
  | 'EMPLOYEE_NOT_FOUND_AT_HCM'
  | 'TERMINAL';

export type ReconciliationStepOutcome = 'PARTIAL' | 'TERMINAL';

export interface ReconciliationStepRow {
  readonly id: string;
  readonly actionId: string;
  readonly stepSequence: number;
  readonly kind: ReconciliationStepKind;
  readonly outcome: ReconciliationStepOutcome;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly workerId: string;
}

interface ReconciliationStepRowRaw {
  id: string;
  actionId: string;
  stepSequence: number;
  kind: ReconciliationStepKind;
  outcome: ReconciliationStepOutcome;
  payload: string;
  occurredAt: string;
  workerId: string;
}

const hydrate = (r: ReconciliationStepRowRaw): ReconciliationStepRow => ({
  id: r.id,
  actionId: r.actionId,
  stepSequence: r.stepSequence,
  kind: r.kind,
  outcome: r.outcome,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  occurredAt: r.occurredAt,
  workerId: r.workerId,
});

const SELECT_COLUMNS = `
  id,
  action_id     AS actionId,
  step_sequence AS stepSequence,
  kind,
  outcome,
  payload,
  occurred_at   AS occurredAt,
  worker_id     AS workerId
`;

export interface AppendStepArgs {
  readonly id: string;
  readonly actionId: string;
  readonly kind: ReconciliationStepKind;
  readonly outcome: ReconciliationStepOutcome;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly workerId: string;
}

@Injectable()
export class ReconciliationStepStore {
  private readonly findLastStmt: Statement<[string]>;
  private readonly listForActionStmt: Statement<[string]>;
  private readonly nextSeqStmt: Statement<[string]>;
  private readonly insertStmt: Statement;

  constructor(@Inject(DATABASE) db: Database) {
    this.findLastStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM reconciliation_step
        WHERE action_id = ?
        ORDER BY step_sequence DESC
        LIMIT 1`,
    );
    this.listForActionStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM reconciliation_step
        WHERE action_id = ?
        ORDER BY step_sequence ASC`,
    );
    this.nextSeqStmt = db.prepare(
      `SELECT COALESCE(MAX(step_sequence), 0) + 1 AS nextSeq
         FROM reconciliation_step
        WHERE action_id = ?`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO reconciliation_step
              (id, action_id, step_sequence, kind, outcome, payload,
               occurred_at, worker_id)
            VALUES
              (:id, :actionId, :stepSequence, :kind, :outcome, :payload,
               :occurredAt, :workerId)`,
    );
  }

  findLast(actionId: string): ReconciliationStepRow | null {
    const row = this.findLastStmt.get(actionId) as ReconciliationStepRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  listForAction(actionId: string): ReconciliationStepRow[] {
    return (this.listForActionStmt.all(actionId) as ReconciliationStepRowRaw[]).map(hydrate);
  }

  /**
   * Append the next step. `stepSequence` is computed inside the same
   * transaction as the insert so concurrent appends remain monotonic.
   */
  append(args: AppendStepArgs): number {
    const row = this.nextSeqStmt.get(args.actionId) as { nextSeq: number };
    const stepSequence = row.nextSeq;
    this.insertStmt.run({
      id: args.id,
      actionId: args.actionId,
      stepSequence,
      kind: args.kind,
      outcome: args.outcome,
      payload: JSON.stringify(args.payload),
      occurredAt: args.occurredAt,
      workerId: args.workerId,
    });
    return stepSequence;
  }
}
