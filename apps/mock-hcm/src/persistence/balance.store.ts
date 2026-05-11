import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { DATABASE } from './database.token';

export interface BalanceRow {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly available: Decimal;
  readonly hcmVersion: bigint;
  readonly appliedAt: string;
}

interface BalanceRowRaw {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  available: string;
  hcmVersion: string;
  appliedAt: string;
}

const hydrate = (r: BalanceRowRaw): BalanceRow => ({
  employeeId: r.employeeId,
  locationId: r.locationId,
  leaveTypeId: r.leaveTypeId,
  available: new Decimal(r.available),
  hcmVersion: BigInt(r.hcmVersion),
  appliedAt: r.appliedAt,
});

const SELECT_COLUMNS = `
  employee_id   AS employeeId,
  location_id   AS locationId,
  leave_type_id AS leaveTypeId,
  available,
  hcm_version   AS hcmVersion,
  applied_at    AS appliedAt
`;

@Injectable()
export class BalanceStore {
  private readonly findStmt: Statement<[string, string, string]>;
  private readonly upsertStmt: Statement<[string, string, string, string, string, string]>;
  private readonly listAllStmt: Statement<[]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM balances
        WHERE employee_id = ? AND location_id = ? AND leave_type_id = ?`,
    );
    this.upsertStmt = db.prepare(
      `INSERT INTO balances
              (employee_id, location_id, leave_type_id, available, hcm_version, applied_at)
            VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(employee_id, location_id, leave_type_id) DO UPDATE SET
              available   = excluded.available,
              hcm_version = excluded.hcm_version,
              applied_at  = excluded.applied_at`,
    );
    this.listAllStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM balances
         ORDER BY employee_id, location_id, leave_type_id`,
    );
  }

  find(employeeId: string, locationId: string, leaveTypeId: string): BalanceRow | null {
    const row = this.findStmt.get(employeeId, locationId, leaveTypeId) as BalanceRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  upsert(row: BalanceRow): void {
    this.upsertStmt.run(
      row.employeeId,
      row.locationId,
      row.leaveTypeId,
      row.available.toFixed(),
      row.hcmVersion.toString(),
      row.appliedAt,
    );
  }

  listAll(): BalanceRow[] {
    return (this.listAllStmt.all() as BalanceRowRaw[]).map(hydrate);
  }
}
