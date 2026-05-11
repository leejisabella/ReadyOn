import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../../infrastructure/persistence/database.token';

export type BootstrapSource = 'WEBHOOK' | 'LAZY_PULL' | 'BATCH';

export interface EmployeeRow {
  readonly employeeId: string;
  readonly bootstrappedAt: string;
  readonly bootstrapSource: BootstrapSource;
  readonly hcmVersion: bigint;
  readonly lastSeenInBatchAt: string | null;
}

interface EmployeeRowRaw {
  employeeId: string;
  bootstrappedAt: string;
  bootstrapSource: BootstrapSource;
  hcmVersion: string;
  lastSeenInBatchAt: string | null;
}

const hydrate = (r: EmployeeRowRaw): EmployeeRow => ({
  employeeId: r.employeeId,
  bootstrappedAt: r.bootstrappedAt,
  bootstrapSource: r.bootstrapSource,
  hcmVersion: BigInt(r.hcmVersion),
  lastSeenInBatchAt: r.lastSeenInBatchAt,
});

const SELECT_COLUMNS = `
  employee_id           AS employeeId,
  bootstrapped_at       AS bootstrappedAt,
  bootstrap_source      AS bootstrapSource,
  hcm_version           AS hcmVersion,
  last_seen_in_batch_at AS lastSeenInBatchAt
`;

@Injectable()
export class EmployeeStore {
  private readonly findStmt: Statement<[string]>;
  private readonly insertIfAbsentStmt: Statement<[string, string, BootstrapSource, string, string | null]>;
  private readonly recordSeenInBatchStmt: Statement<[string, string]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM employee
        WHERE employee_id = ?`,
    );
    /*
     * INSERT OR IGNORE makes concurrent bootstrap paths safe — webhook,
     * lazy-pull, and batch can race; whichever lands first wins, the others
     * silently no-op. TRD §11.5, ADR-012.
     */
    this.insertIfAbsentStmt = db.prepare(
      `INSERT OR IGNORE INTO employee
              (employee_id, bootstrapped_at, bootstrap_source, hcm_version, last_seen_in_batch_at)
            VALUES (?, ?, ?, ?, ?)`,
    );
    this.recordSeenInBatchStmt = db.prepare(
      `UPDATE employee SET last_seen_in_batch_at = ? WHERE employee_id = ?`,
    );
  }

  find(employeeId: string): EmployeeRow | null {
    const row = this.findStmt.get(employeeId) as EmployeeRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * Idempotent insert. Returns `true` when this call created the row, `false`
   * when a concurrent path got there first.
   */
  insertIfAbsent(row: EmployeeRow): boolean {
    const result = this.insertIfAbsentStmt.run(
      row.employeeId,
      row.bootstrappedAt,
      row.bootstrapSource,
      row.hcmVersion.toString(),
      row.lastSeenInBatchAt,
    );
    return result.changes > 0;
  }

  /** No-op when the employee row is absent. */
  recordSeenInBatch(employeeId: string, seenAt: string): void {
    this.recordSeenInBatchStmt.run(seenAt, employeeId);
  }
}
