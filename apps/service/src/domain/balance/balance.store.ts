import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { DATABASE } from '../../infrastructure/persistence/database.token';
import type { Holds } from './hold-accountant';

export type BalanceState = 'SYNCED' | 'RECONCILING' | 'UNDER_HOLD_DEFICIT' | 'STALE';

export interface BalanceRow {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly available: Decimal;
  readonly holds: Holds;
  readonly hcmVersion: bigint;
  readonly hcmEffectiveAt: string;
  readonly localUpdatedAt: string;
  readonly lastReconciledAt: string;
  readonly state: BalanceState;
}

interface BalanceRowRaw {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  available: string;
  pendingHold: string;
  approvedHold: string;
  provisionalHold: string;
  hcmVersion: string;
  hcmEffectiveAt: string;
  localUpdatedAt: string;
  lastReconciledAt: string;
  state: BalanceState;
}

const hydrate = (r: BalanceRowRaw): BalanceRow => ({
  employeeId: r.employeeId,
  locationId: r.locationId,
  leaveTypeId: r.leaveTypeId,
  available: new Decimal(r.available),
  holds: {
    pending: new Decimal(r.pendingHold),
    approved: new Decimal(r.approvedHold),
    provisional: new Decimal(r.provisionalHold),
  },
  hcmVersion: BigInt(r.hcmVersion),
  hcmEffectiveAt: r.hcmEffectiveAt,
  localUpdatedAt: r.localUpdatedAt,
  lastReconciledAt: r.lastReconciledAt,
  state: r.state,
});

const SELECT_COLUMNS = `
  employee_id        AS employeeId,
  location_id        AS locationId,
  leave_type_id      AS leaveTypeId,
  available,
  pending_hold       AS pendingHold,
  approved_hold      AS approvedHold,
  provisional_hold   AS provisionalHold,
  hcm_version        AS hcmVersion,
  hcm_effective_at   AS hcmEffectiveAt,
  local_updated_at   AS localUpdatedAt,
  last_reconciled_at AS lastReconciledAt,
  state
`;

/** Inserts a brand-new row with zero holds. */
export interface InsertBalanceArgs {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly available: Decimal;
  readonly hcmVersion: bigint;
  readonly hcmEffectiveAt: string;
  readonly at: string;
  readonly state: BalanceState;
}

/** Replaces HCM-sourced fields (preserves holds). */
export interface UpdateAvailableArgs {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly available: Decimal;
  readonly hcmVersion: bigint;
  readonly hcmEffectiveAt: string;
  readonly at: string;
  readonly state: BalanceState;
}

/** Replaces hold buckets (preserves `available` / `hcm_version`). */
export interface UpdateHoldsArgs {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly holds: Holds;
  readonly at: string;
  readonly state: BalanceState;
}

@Injectable()
export class BalanceStore {
  private readonly findStmt: Statement<[string, string, string]>;
  private readonly listForEmployeeStmt: Statement<[string]>;
  private readonly insertStmt: Statement;
  private readonly updateAvailableStmt: Statement;
  private readonly updateHoldsStmt: Statement;
  private readonly listStaleStmt: Statement<[string, number]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM balance
        WHERE employee_id = ? AND location_id = ? AND leave_type_id = ?`,
    );
    this.listForEmployeeStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM balance
        WHERE employee_id = ?
        ORDER BY location_id, leave_type_id`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO balance
              (employee_id, location_id, leave_type_id, available,
               pending_hold, approved_hold, provisional_hold,
               hcm_version, hcm_effective_at, local_updated_at, last_reconciled_at, state)
            VALUES
              (:employeeId, :locationId, :leaveTypeId, :available,
               '0', '0', '0',
               :hcmVersion, :hcmEffectiveAt, :at, :at, :state)`,
    );
    this.updateAvailableStmt = db.prepare(
      `UPDATE balance
          SET available          = :available,
              hcm_version        = :hcmVersion,
              hcm_effective_at   = :hcmEffectiveAt,
              local_updated_at   = :at,
              last_reconciled_at = :at,
              state              = :state
        WHERE employee_id = :employeeId
          AND location_id = :locationId
          AND leave_type_id = :leaveTypeId`,
    );
    this.updateHoldsStmt = db.prepare(
      `UPDATE balance
          SET pending_hold     = :pending,
              approved_hold    = :approved,
              provisional_hold = :provisional,
              local_updated_at = :at,
              state            = :state
        WHERE employee_id = :employeeId
          AND location_id = :locationId
          AND leave_type_id = :leaveTypeId`,
    );
    this.listStaleStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM balance
        WHERE last_reconciled_at < ?
        ORDER BY last_reconciled_at ASC
        LIMIT ?`,
    );
  }

  find(employeeId: string, locationId: string, leaveTypeId: string): BalanceRow | null {
    const row = this.findStmt.get(employeeId, locationId, leaveTypeId) as
      | BalanceRowRaw
      | undefined;
    return row ? hydrate(row) : null;
  }

  listForEmployee(employeeId: string): BalanceRow[] {
    return (this.listForEmployeeStmt.all(employeeId) as BalanceRowRaw[]).map(hydrate);
  }

  /** Balances whose `last_reconciled_at` precedes the cutoff. Used by drift sweep. */
  listStale(beforeIso: string, limit: number = 1000): BalanceRow[] {
    return (this.listStaleStmt.all(beforeIso, limit) as BalanceRowRaw[]).map(hydrate);
  }

  insert(args: InsertBalanceArgs): void {
    this.insertStmt.run({
      employeeId: args.employeeId,
      locationId: args.locationId,
      leaveTypeId: args.leaveTypeId,
      available: args.available.toFixed(),
      hcmVersion: args.hcmVersion.toString(),
      hcmEffectiveAt: args.hcmEffectiveAt,
      at: args.at,
      state: args.state,
    });
  }

  updateAvailable(args: UpdateAvailableArgs): void {
    this.updateAvailableStmt.run({
      employeeId: args.employeeId,
      locationId: args.locationId,
      leaveTypeId: args.leaveTypeId,
      available: args.available.toFixed(),
      hcmVersion: args.hcmVersion.toString(),
      hcmEffectiveAt: args.hcmEffectiveAt,
      at: args.at,
      state: args.state,
    });
  }

  updateHolds(args: UpdateHoldsArgs): void {
    this.updateHoldsStmt.run({
      employeeId: args.employeeId,
      locationId: args.locationId,
      leaveTypeId: args.leaveTypeId,
      pending: args.holds.pending.toFixed(),
      approved: args.holds.approved.toFixed(),
      provisional: args.holds.provisional.toFixed(),
      at: args.at,
      state: args.state,
    });
  }
}
