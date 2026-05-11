import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../persistence/database.token';

export type OutboxEntryType =
  | 'RESERVE_BALANCE'
  | 'RELEASE_BALANCE'
  | 'FETCH_BALANCE'
  | 'BOOTSTRAP_EMPLOYEE'
  | 'RECONCILE_PROVISIONAL';

export type OutboxEntryState =
  | 'PENDING'
  | 'IN_FLIGHT'
  | 'SUCCEEDED'
  | 'SUSPECT_NO_OP'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT';

export interface OutboxEntry {
  readonly id: string;
  readonly type: OutboxEntryType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: OutboxEntryState;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface OutboxRowRaw {
  id: string;
  type: OutboxEntryType;
  payload: string;
  state: OutboxEntryState;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

const hydrate = (r: OutboxRowRaw): OutboxEntry => ({
  id: r.id,
  type: r.type,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  state: r.state,
  attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt,
  lastError: r.lastError,
  idempotencyKey: r.idempotencyKey,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const SELECT_COLUMNS = `
  id,
  type,
  payload,
  state,
  attempts,
  next_attempt_at AS nextAttemptAt,
  last_error      AS lastError,
  idempotency_key AS idempotencyKey,
  created_at      AS createdAt,
  updated_at      AS updatedAt
`;

export interface EnqueueArgs {
  readonly id: string;
  readonly type: OutboxEntryType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly at: string;
}

/**
 * Append-and-claim store for the asynchronous side-effect queue.
 *
 * Atomicity is owned by the `claim` statement — a single SQLite update that
 * moves up to `batchSize` rows from `PENDING` to `IN_FLIGHT` and returns
 * them. The worker dispatches each row and then writes a terminal/retry
 * state via the `record*` methods.
 *
 * @ref docs/01_TRD.md §5.7, §10.3
 * @ref docs/04_Module_Plan.md §3.11
 */
@Injectable()
export class OutboxStore {
  private readonly findStmt: Statement<[string]>;
  private readonly listByStateStmt: Statement<[OutboxEntryState]>;
  private readonly insertStmt: Statement;
  private readonly claimStmt: Statement;
  private readonly markSucceededStmt: Statement;
  private readonly markPermanentStmt: Statement;
  private readonly markRetryableStmt: Statement;
  private readonly markSuspectNoOpStmt: Statement;
  private readonly recoverInFlightStmt: Statement<[string]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM outbox_entry WHERE id = ?`,
    );
    this.listByStateStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM outbox_entry WHERE state = ? ORDER BY next_attempt_at ASC`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO outbox_entry
              (id, type, payload, state, attempts, next_attempt_at,
               idempotency_key, created_at, updated_at)
            VALUES
              (:id, :type, :payload, 'PENDING', 0, :at, :idempotencyKey, :at, :at)`,
    );
    /*
     * Atomic claim: select the next batch, advance state to IN_FLIGHT, and
     * return the claimed rows. SQLite serializes writes; better-sqlite3 runs
     * this as a single statement.
     */
    this.claimStmt = db.prepare(
      `UPDATE outbox_entry
          SET state      = 'IN_FLIGHT',
              attempts   = attempts + 1,
              updated_at = :at
        WHERE id IN (
          SELECT id FROM outbox_entry
           WHERE state = 'PENDING'
             AND next_attempt_at <= :at
           ORDER BY next_attempt_at ASC
           LIMIT :batchSize
        )
      RETURNING ${SELECT_COLUMNS}`,
    );
    this.markSucceededStmt = db.prepare(
      `UPDATE outbox_entry
          SET state      = 'SUCCEEDED',
              last_error = NULL,
              updated_at = :at
        WHERE id = :id`,
    );
    this.markPermanentStmt = db.prepare(
      `UPDATE outbox_entry
          SET state      = 'FAILED_PERMANENT',
              last_error = :error,
              updated_at = :at
        WHERE id = :id`,
    );
    this.markRetryableStmt = db.prepare(
      `UPDATE outbox_entry
          SET state           = :nextState,
              last_error      = :error,
              next_attempt_at = :nextAttemptAt,
              updated_at      = :at
        WHERE id = :id`,
    );
    this.markSuspectNoOpStmt = db.prepare(
      `UPDATE outbox_entry
          SET state      = 'SUSPECT_NO_OP',
              last_error = :error,
              updated_at = :at
        WHERE id = :id`,
    );
    /*
     * Crash-recovery sweep: anything stuck in IN_FLIGHT past a deadline gets
     * dropped back to PENDING. Called by the worker on first tick (or
     * explicitly on application bootstrap).
     */
    this.recoverInFlightStmt = db.prepare(
      `UPDATE outbox_entry
          SET state = 'PENDING'
        WHERE state = 'IN_FLIGHT'
          AND updated_at < ?`,
    );
  }

  find(id: string): OutboxEntry | null {
    const row = this.findStmt.get(id) as OutboxRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  listByState(state: OutboxEntryState): OutboxEntry[] {
    return (this.listByStateStmt.all(state) as OutboxRowRaw[]).map(hydrate);
  }

  enqueue(args: EnqueueArgs): void {
    this.insertStmt.run({
      id: args.id,
      type: args.type,
      payload: JSON.stringify(args.payload),
      idempotencyKey: args.idempotencyKey,
      at: args.at,
    });
  }

  claim(args: { readonly now: string; readonly batchSize: number }): OutboxEntry[] {
    const rows = this.claimStmt.all({
      at: args.now,
      batchSize: args.batchSize,
    }) as OutboxRowRaw[];
    return rows.map(hydrate);
  }

  markSucceeded(id: string, at: string): void {
    this.markSucceededStmt.run({ id, at });
  }

  markPermanentFailure(id: string, error: string, at: string): void {
    this.markPermanentStmt.run({ id, error, at });
  }

  markRetryableFailure(args: {
    readonly id: string;
    readonly error: string;
    readonly nextAttemptAt: string;
    readonly at: string;
    /** `'PENDING'` for ordinary retry; `'FAILED_RETRYABLE'` when attempts exhausted. */
    readonly nextState: 'PENDING' | 'FAILED_RETRYABLE';
  }): void {
    this.markRetryableStmt.run(args);
  }

  markSuspectNoOp(id: string, error: string, at: string): void {
    this.markSuspectNoOpStmt.run({ id, error, at });
  }

  /**
   * Reset rows stuck in `IN_FLIGHT` past `before` back to `PENDING`. Run on
   * worker startup so a crashed dispatcher's claimed rows are reclaimable.
   */
  recoverStaleInFlight(before: string): void {
    this.recoverInFlightStmt.run(before);
  }
}
