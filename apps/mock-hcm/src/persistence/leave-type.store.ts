import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from './database.token';

export interface LeaveTypeRow {
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
  readonly hcmVersion: bigint;
}

interface LeaveTypeRowRaw {
  locationId: string;
  leaveTypeId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: number;
  hcmVersion: string;
}

const hydrate = (r: LeaveTypeRowRaw): LeaveTypeRow => ({
  locationId: r.locationId,
  leaveTypeId: r.leaveTypeId,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  isActive: r.isActive === 1,
  hcmVersion: BigInt(r.hcmVersion),
});

@Injectable()
export class LeaveTypeStore {
  private readonly listForLocationStmt: Statement<[string]>;
  private readonly upsertStmt: Statement<[string, string, string, string | null, number, string]>;
  private readonly listAllStmt: Statement<[]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.listForLocationStmt = db.prepare(
      `SELECT location_id    AS locationId,
              leave_type_id  AS leaveTypeId,
              effective_from AS effectiveFrom,
              effective_to   AS effectiveTo,
              is_active      AS isActive,
              hcm_version    AS hcmVersion
         FROM leave_types
        WHERE location_id = ?
        ORDER BY leave_type_id, effective_from`,
    );
    this.upsertStmt = db.prepare(
      `INSERT INTO leave_types
              (location_id, leave_type_id, effective_from, effective_to, is_active, hcm_version)
            VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id, leave_type_id, effective_from) DO UPDATE SET
              effective_to = excluded.effective_to,
              is_active    = excluded.is_active,
              hcm_version  = excluded.hcm_version`,
    );
    this.listAllStmt = db.prepare(
      `SELECT location_id AS locationId, leave_type_id AS leaveTypeId,
              effective_from AS effectiveFrom, effective_to AS effectiveTo,
              is_active AS isActive, hcm_version AS hcmVersion
         FROM leave_types
         ORDER BY location_id, leave_type_id, effective_from`,
    );
  }

  listForLocation(locationId: string): LeaveTypeRow[] {
    return (this.listForLocationStmt.all(locationId) as LeaveTypeRowRaw[]).map(hydrate);
  }

  upsert(row: LeaveTypeRow): void {
    this.upsertStmt.run(
      row.locationId,
      row.leaveTypeId,
      row.effectiveFrom,
      row.effectiveTo,
      row.isActive ? 1 : 0,
      row.hcmVersion.toString(),
    );
  }

  listAll(): LeaveTypeRow[] {
    return (this.listAllStmt.all() as LeaveTypeRowRaw[]).map(hydrate);
  }
}
