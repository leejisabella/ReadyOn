import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from './database.token';

export interface EmploymentRow {
  readonly employeeId: string;
  readonly locationId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly hcmVersion: bigint;
}

@Injectable()
export class EmploymentStore {
  private readonly listForEmployeeStmt: Statement<[string]>;
  private readonly upsertStmt: Statement<[string, string, string, string | null, string]>;
  private readonly listAllStmt: Statement<[]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.listForEmployeeStmt = db.prepare(
      `SELECT employee_id    AS employeeId,
              location_id    AS locationId,
              effective_from AS effectiveFrom,
              effective_to   AS effectiveTo,
              hcm_version    AS hcmVersion
         FROM employment
        WHERE employee_id = ?
        ORDER BY effective_from ASC`,
    );
    this.upsertStmt = db.prepare(
      `INSERT INTO employment (employee_id, location_id, effective_from, effective_to, hcm_version)
            VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(employee_id, effective_from) DO UPDATE SET
              location_id  = excluded.location_id,
              effective_to = excluded.effective_to,
              hcm_version  = excluded.hcm_version`,
    );
    this.listAllStmt = db.prepare(
      `SELECT employee_id AS employeeId, location_id AS locationId,
              effective_from AS effectiveFrom, effective_to AS effectiveTo,
              hcm_version AS hcmVersion
         FROM employment
         ORDER BY employee_id, effective_from`,
    );
  }

  listForEmployee(employeeId: string): EmploymentRow[] {
    const rows = this.listForEmployeeStmt.all(employeeId) as ReadonlyArray<{
      employeeId: string;
      locationId: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      hcmVersion: string;
    }>;
    return rows.map((r) => ({ ...r, hcmVersion: BigInt(r.hcmVersion) }));
  }

  upsert(row: EmploymentRow): void {
    this.upsertStmt.run(
      row.employeeId,
      row.locationId,
      row.effectiveFrom,
      row.effectiveTo,
      row.hcmVersion.toString(),
    );
  }

  listAll(): EmploymentRow[] {
    const rows = this.listAllStmt.all() as ReadonlyArray<{
      employeeId: string;
      locationId: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      hcmVersion: string;
    }>;
    return rows.map((r) => ({ ...r, hcmVersion: BigInt(r.hcmVersion) }));
  }
}
