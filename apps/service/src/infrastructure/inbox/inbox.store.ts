import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../persistence/database.token';

export type InboxSource = 'WEBHOOK' | 'BATCH';

export type InboxEventType =
  | 'BALANCE_UPDATED'
  | 'EMPLOYMENT_CHANGED'
  | 'LEAVE_TYPE_CHANGED'
  | 'EMPLOYEE_CREATED';

export interface InboxEventRow {
  readonly id: string;
  readonly source: InboxSource;
  readonly type: InboxEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly hcmVersion: bigint;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly processingError: string | null;
}

interface InboxRowRaw {
  id: string;
  source: InboxSource;
  type: InboxEventType;
  payload: string;
  hcmVersion: string;
  receivedAt: string;
  processedAt: string | null;
  processingError: string | null;
}

const hydrate = (r: InboxRowRaw): InboxEventRow => ({
  id: r.id,
  source: r.source,
  type: r.type,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  hcmVersion: BigInt(r.hcmVersion),
  receivedAt: r.receivedAt,
  processedAt: r.processedAt,
  processingError: r.processingError,
});

const SELECT_COLUMNS = `
  id,
  source,
  type,
  payload,
  hcm_version       AS hcmVersion,
  received_at       AS receivedAt,
  processed_at      AS processedAt,
  processing_error  AS processingError
`;

export interface IngestArgs {
  readonly id: string;
  readonly source: InboxSource;
  readonly type: InboxEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly hcmVersion: bigint;
  readonly receivedAt: string;
}

/**
 * Insertion is idempotent on `id` (HCM-supplied dedupe key) — duplicate
 * deliveries land as silent no-ops via `INSERT OR IGNORE`. Processing
 * outcomes are persisted alongside the row so failures surface in audit
 * without re-running the dispatcher.
 *
 * @ref docs/01_TRD.md §5.7, §10.1
 * @ref docs/04_Module_Plan.md §3.12
 */
@Injectable()
export class InboxStore {
  private readonly findStmt: Statement<[string]>;
  private readonly ingestStmt: Statement;
  private readonly claimUnprocessedStmt: Statement<[number]>;
  private readonly markProcessedStmt: Statement;
  private readonly markErrorStmt: Statement;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM inbox_event WHERE id = ?`,
    );
    this.ingestStmt = db.prepare(
      `INSERT OR IGNORE INTO inbox_event
              (id, source, type, payload, hcm_version, received_at)
            VALUES (:id, :source, :type, :payload, :hcmVersion, :receivedAt)`,
    );
    this.claimUnprocessedStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM inbox_event
        WHERE processed_at IS NULL
        ORDER BY received_at ASC
        LIMIT ?`,
    );
    this.markProcessedStmt = db.prepare(
      `UPDATE inbox_event
          SET processed_at     = :at,
              processing_error = NULL
        WHERE id = :id`,
    );
    this.markErrorStmt = db.prepare(
      `UPDATE inbox_event SET processing_error = :error WHERE id = :id`,
    );
  }

  find(id: string): InboxEventRow | null {
    const row = this.findStmt.get(id) as InboxRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * Insert if absent (dedup on `id`). Returns whether a new row was created.
   * `INSERT OR IGNORE` makes duplicate deliveries safe.
   */
  ingest(args: IngestArgs): boolean {
    const result = this.ingestStmt.run({
      id: args.id,
      source: args.source,
      type: args.type,
      payload: JSON.stringify(args.payload),
      hcmVersion: args.hcmVersion.toString(),
      receivedAt: args.receivedAt,
    });
    return result.changes > 0;
  }

  claimUnprocessed(batchSize: number): InboxEventRow[] {
    return (this.claimUnprocessedStmt.all(batchSize) as InboxRowRaw[]).map(hydrate);
  }

  markProcessed(id: string, at: string): void {
    this.markProcessedStmt.run({ id, at });
  }

  /** Records the error message; row stays unprocessed so the next tick retries. */
  markError(id: string, error: string): void {
    this.markErrorStmt.run({ id, error });
  }
}
