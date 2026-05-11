import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { DATABASE } from './database.token';

export type TransactionOutcome = 'ACCEPTED' | 'REJECTED';

export interface TransactionRecord {
  readonly transactionId: string;
  readonly idempotencyKey: string | null;
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly deltaApplied: Decimal;
  readonly newAvailable: Decimal;
  readonly hcmVersion: bigint;
  readonly appliedAt: string;
  readonly outcome: TransactionOutcome;
  readonly rejectionReason: string | null;
  readonly statusCode: number;
  /** Verbatim response body returned to the caller; used for idempotent replay. */
  readonly responseBody: unknown;
}

export interface QueryTransactionsFilter {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly idempotencyKey?: string;
  readonly window?: { readonly start: string; readonly end: string };
}

interface TransactionRowRaw {
  transactionId: string;
  idempotencyKey: string | null;
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  deltaApplied: string;
  newAvailable: string;
  hcmVersion: string;
  appliedAt: string;
  outcome: TransactionOutcome;
  rejectionReason: string | null;
  statusCode: number;
  responseBodyJson: string;
}

const hydrate = (r: TransactionRowRaw): TransactionRecord => ({
  transactionId: r.transactionId,
  idempotencyKey: r.idempotencyKey,
  employeeId: r.employeeId,
  locationId: r.locationId,
  leaveTypeId: r.leaveTypeId,
  deltaApplied: new Decimal(r.deltaApplied),
  newAvailable: new Decimal(r.newAvailable),
  hcmVersion: BigInt(r.hcmVersion),
  appliedAt: r.appliedAt,
  outcome: r.outcome,
  rejectionReason: r.rejectionReason,
  statusCode: r.statusCode,
  responseBody: JSON.parse(r.responseBodyJson) as unknown,
});

const SELECT_COLUMNS = `
  transaction_id     AS transactionId,
  idempotency_key    AS idempotencyKey,
  employee_id        AS employeeId,
  location_id        AS locationId,
  leave_type_id      AS leaveTypeId,
  delta_applied      AS deltaApplied,
  new_available      AS newAvailable,
  hcm_version        AS hcmVersion,
  applied_at         AS appliedAt,
  outcome,
  rejection_reason   AS rejectionReason,
  status_code        AS statusCode,
  response_body_json AS responseBodyJson
`;

@Injectable()
export class TransactionStore {
  private readonly findByIdemStmt: Statement<[string]>;
  private readonly insertStmt: Statement;
  private readonly queryStmt: Statement;
  private readonly listAllStmt: Statement<[]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findByIdemStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM transactions
        WHERE idempotency_key = ?
        LIMIT 1`,
    );

    this.insertStmt = db.prepare(
      `INSERT INTO transactions
              (transaction_id, idempotency_key, employee_id, location_id, leave_type_id,
               delta_applied, new_available, hcm_version, applied_at,
               outcome, rejection_reason, status_code, response_body_json)
            VALUES
              (:transactionId, :idempotencyKey, :employeeId, :locationId, :leaveTypeId,
               :deltaApplied, :newAvailable, :hcmVersion, :appliedAt,
               :outcome, :rejectionReason, :statusCode, :responseBodyJson)`,
    );

    /*
     * `queryTransactions` (TRD §13.2.1). The reconciler filters by:
     *   - dimensions (always)
     *   - idempotency key (optional — when set, expects at most one row)
     *   - applied_at window (optional — default 24h, ADR-024)
     *
     * Optional filters use the `:param IS NULL OR <pred>` idiom so a single
     * prepared statement handles every combination.
     */
    this.queryStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM transactions
        WHERE outcome = 'ACCEPTED'
          AND employee_id   = :employeeId
          AND location_id   = :locationId
          AND leave_type_id = :leaveTypeId
          AND (:idempotencyKey IS NULL OR idempotency_key = :idempotencyKey)
          AND (:windowStart    IS NULL OR applied_at >= :windowStart)
          AND (:windowEnd      IS NULL OR applied_at <= :windowEnd)
        ORDER BY applied_at ASC`,
    );

    this.listAllStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM transactions
         ORDER BY applied_at, transaction_id`,
    );
  }

  /**
   * Look up a transaction by its idempotency key. Used by reserve/release
   * handlers to replay a prior response verbatim on retry.
   */
  findByIdempotencyKey(key: string): TransactionRecord | null {
    const row = this.findByIdemStmt.get(key) as TransactionRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  insert(record: TransactionRecord): void {
    this.insertStmt.run({
      transactionId: record.transactionId,
      idempotencyKey: record.idempotencyKey,
      employeeId: record.employeeId,
      locationId: record.locationId,
      leaveTypeId: record.leaveTypeId,
      deltaApplied: record.deltaApplied.toFixed(),
      newAvailable: record.newAvailable.toFixed(),
      hcmVersion: record.hcmVersion.toString(),
      appliedAt: record.appliedAt,
      outcome: record.outcome,
      rejectionReason: record.rejectionReason,
      statusCode: record.statusCode,
      responseBodyJson: JSON.stringify(record.responseBody),
    });
  }

  /**
   * Search for ACCEPTED transactions matching the filter. Empty result is a
   * valid outcome (HCM applied nothing matching).
   *
   * @ref docs/01_TRD.md §13.2.1
   */
  query(filter: QueryTransactionsFilter): TransactionRecord[] {
    const rows = this.queryStmt.all({
      employeeId: filter.employeeId,
      locationId: filter.locationId,
      leaveTypeId: filter.leaveTypeId,
      idempotencyKey: filter.idempotencyKey ?? null,
      windowStart: filter.window?.start ?? null,
      windowEnd: filter.window?.end ?? null,
    }) as TransactionRowRaw[];
    return rows.map(hydrate);
  }

  /** For admin `/state` and test introspection. */
  listAll(): TransactionRecord[] {
    return (this.listAllStmt.all() as TransactionRowRaw[]).map(hydrate);
  }
}
