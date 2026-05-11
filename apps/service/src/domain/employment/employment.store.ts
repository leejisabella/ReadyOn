import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../../infrastructure/persistence/database.token';

export interface EmploymentPeriod {
  readonly employeeId: string;
  readonly locationId: string;
  /** ISO-8601 date `YYYY-MM-DD`, inclusive. */
  readonly effectiveFrom: string;
  /** ISO-8601 date `YYYY-MM-DD`, inclusive. `null` = currently active. */
  readonly effectiveTo: string | null;
  readonly hcmVersion: bigint;
}

interface EmploymentRowRaw {
  employeeId: string;
  locationId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  hcmVersion: string;
}

const hydrate = (r: EmploymentRowRaw): EmploymentPeriod => ({
  employeeId: r.employeeId,
  locationId: r.locationId,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  hcmVersion: BigInt(r.hcmVersion),
});

const SELECT_COLUMNS = `
  employee_id    AS employeeId,
  location_id    AS locationId,
  effective_from AS effectiveFrom,
  effective_to   AS effectiveTo,
  hcm_version    AS hcmVersion
`;

@Injectable()
export class EmploymentStore {
  private readonly findStmt: Statement<[string, string]>;
  private readonly findActiveStmt: Statement<[string, string, string]>;
  private readonly listForEmployeeStmt: Statement<[string]>;
  private readonly applyIfNewerStmt: Statement<[string, string, string, string | null, string]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM employment
        WHERE employee_id = ? AND effective_from = ?`,
    );
    this.findActiveStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM employment
        WHERE employee_id = ?
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from DESC
        LIMIT 1`,
    );
    this.listForEmployeeStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM employment
        WHERE employee_id = ?
        ORDER BY effective_from ASC`,
    );

    /*
     * Conditional upsert. Inserts when no row exists for the (employee,
     * effective_from) key; updates only when the incoming `hcm_version` is
     * strictly greater than the stored one — stale replays no-op silently.
     *
     * The CAST-to-INTEGER is required because we store hcmVersion as TEXT;
     * SQLite would otherwise compare strings lexicographically and treat
     * '9' > '10'.
     */
    this.applyIfNewerStmt = db.prepare(
      `INSERT INTO employment (employee_id, location_id, effective_from, effective_to, hcm_version)
            VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(employee_id, effective_from) DO UPDATE SET
              location_id  = excluded.location_id,
              effective_to = excluded.effective_to,
              hcm_version  = excluded.hcm_version
            WHERE CAST(employment.hcm_version AS INTEGER) < CAST(excluded.hcm_version AS INTEGER)`,
    );
  }

  find(employeeId: string, effectiveFrom: string): EmploymentPeriod | null {
    const row = this.findStmt.get(employeeId, effectiveFrom) as EmploymentRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  /** The period covering `asOfDate` (both bounds inclusive), or null when none. */
  findActiveAt(employeeId: string, asOfDate: string): EmploymentPeriod | null {
    const row = this.findActiveStmt.get(employeeId, asOfDate, asOfDate) as
      | EmploymentRowRaw
      | undefined;
    return row ? hydrate(row) : null;
  }

  listForEmployee(employeeId: string): EmploymentPeriod[] {
    return (this.listForEmployeeStmt.all(employeeId) as EmploymentRowRaw[]).map(hydrate);
  }

  /**
   * Apply an HCM-sourced employment row. Returns `true` when the local state
   * advanced (new period inserted, or existing period replaced by a newer
   * version), `false` when the call was a no-op (existing version >=
   * incoming, including exact replays).
   */
  applyIfNewer(period: EmploymentPeriod): boolean {
    const result = this.applyIfNewerStmt.run(
      period.employeeId,
      period.locationId,
      period.effectiveFrom,
      period.effectiveTo,
      period.hcmVersion.toString(),
    );
    return result.changes > 0;
  }
}
