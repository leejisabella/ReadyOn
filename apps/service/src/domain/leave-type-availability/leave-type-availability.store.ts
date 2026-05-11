import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../../infrastructure/persistence/database.token';

export interface LeaveTypeAvailabilityPeriod {
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
  readonly hcmVersion: bigint;
}

interface LeaveTypeAvailabilityRowRaw {
  locationId: string;
  leaveTypeId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: number;
  hcmVersion: string;
}

const hydrate = (r: LeaveTypeAvailabilityRowRaw): LeaveTypeAvailabilityPeriod => ({
  locationId: r.locationId,
  leaveTypeId: r.leaveTypeId,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  isActive: r.isActive === 1,
  hcmVersion: BigInt(r.hcmVersion),
});

const SELECT_COLUMNS = `
  location_id    AS locationId,
  leave_type_id  AS leaveTypeId,
  effective_from AS effectiveFrom,
  effective_to   AS effectiveTo,
  is_active      AS isActive,
  hcm_version    AS hcmVersion
`;

@Injectable()
export class LeaveTypeAvailabilityStore {
  private readonly findStmt: Statement<[string, string, string]>;
  private readonly findActiveStmt: Statement<[string, string, string, string]>;
  private readonly listForLocationStmt: Statement<[string]>;
  private readonly applyIfNewerStmt: Statement<[string, string, string, string | null, number, string]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM leave_type_availability
        WHERE location_id = ? AND leave_type_id = ? AND effective_from = ?`,
    );
    this.findActiveStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM leave_type_availability
        WHERE location_id = ?
          AND leave_type_id = ?
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from DESC
        LIMIT 1`,
    );
    this.listForLocationStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM leave_type_availability
        WHERE location_id = ?
        ORDER BY leave_type_id, effective_from`,
    );

    /*
     * Conditional upsert mirroring EmploymentStore — version-gated so stale
     * replays no-op silently. INTEGER cast on `hcm_version` is required
     * because the column is TEXT.
     */
    this.applyIfNewerStmt = db.prepare(
      `INSERT INTO leave_type_availability
              (location_id, leave_type_id, effective_from, effective_to, is_active, hcm_version)
            VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id, leave_type_id, effective_from) DO UPDATE SET
              effective_to = excluded.effective_to,
              is_active    = excluded.is_active,
              hcm_version  = excluded.hcm_version
            WHERE CAST(leave_type_availability.hcm_version AS INTEGER)
                < CAST(excluded.hcm_version AS INTEGER)`,
    );
  }

  find(
    locationId: string,
    leaveTypeId: string,
    effectiveFrom: string,
  ): LeaveTypeAvailabilityPeriod | null {
    const row = this.findStmt.get(locationId, leaveTypeId, effectiveFrom) as
      | LeaveTypeAvailabilityRowRaw
      | undefined;
    return row ? hydrate(row) : null;
  }

  /** Period covering `asOfDate` for the given `(location, leaveType)`, or null. */
  findActiveAt(
    locationId: string,
    leaveTypeId: string,
    asOfDate: string,
  ): LeaveTypeAvailabilityPeriod | null {
    const row = this.findActiveStmt.get(locationId, leaveTypeId, asOfDate, asOfDate) as
      | LeaveTypeAvailabilityRowRaw
      | undefined;
    return row ? hydrate(row) : null;
  }

  listForLocation(locationId: string): LeaveTypeAvailabilityPeriod[] {
    return (this.listForLocationStmt.all(locationId) as LeaveTypeAvailabilityRowRaw[]).map(hydrate);
  }

  /** See {@link EmploymentStore.applyIfNewer} — same convergence semantics. */
  applyIfNewer(period: LeaveTypeAvailabilityPeriod): boolean {
    const result = this.applyIfNewerStmt.run(
      period.locationId,
      period.leaveTypeId,
      period.effectiveFrom,
      period.effectiveTo,
      period.isActive ? 1 : 0,
      period.hcmVersion.toString(),
    );
    return result.changes > 0;
  }
}
