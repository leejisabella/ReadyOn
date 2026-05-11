import { Inject, Injectable } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { DATABASE } from '../../infrastructure/persistence/database.token';
import {
  BalanceStore,
  type BalanceRow,
  type BalanceState,
} from './balance.store';
import { HoldAccountant, type Holds, type HoldKind } from './hold-accountant';

/**
 * HCM-sourced balance snapshot (BALANCE_UPDATED event or initial bootstrap).
 * The inbox processor or bootstrap service constructs this from wire types.
 */
export interface BalanceSnapshot {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly available: Decimal;
  readonly hcmVersion: bigint;
  readonly hcmEffectiveAt: string;
}

/**
 * Owns the local balance projection — `available` plus the three hold buckets
 * (`pending` / `approved` / `provisional`, TRD §4.1, §5.1).
 *
 * State transitions follow TRD §6.1:
 *   - Inserts and HCM updates set `SYNCED` unless total holds exceed the new
 *     `available`, in which case `UNDER_HOLD_DEFICIT` is set.
 *   - Local hold mutations recompute state the same way.
 *   - `RECONCILING` is sticky — managed exclusively by the reconciler
 *     (Slice 14+). Other operations preserve it.
 *
 * Multi-step ops (read → compute → write) run inside a SQLite transaction so
 * a partial state is impossible if a single step throws.
 *
 * @ref docs/01_TRD.md §5.1, §6.1
 * @ref docs/04_Module_Plan.md §3.3
 */
@Injectable()
export class BalanceService {
  constructor(
    private readonly store: BalanceStore,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  get(employeeId: string, locationId: string, leaveTypeId: string): BalanceRow | null {
    return this.store.find(employeeId, locationId, leaveTypeId);
  }

  listForEmployee(employeeId: string): BalanceRow[] {
    return this.store.listForEmployee(employeeId);
  }

  /**
   * Increment a hold bucket. Throws `HoldDeltaError` if the resulting bucket
   * value would be negative; throws `Error` if the balance row is absent
   * (callers must ensure bootstrap + HCM-populated balance first).
   */
  applyHold(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    units: Decimal,
    kind: HoldKind,
  ): void {
    this.mutateHolds(employeeId, locationId, leaveTypeId, (holds) =>
      HoldAccountant.apply(holds, kind, units),
    );
  }

  /** Symmetric inverse of `applyHold` — decrements the bucket by `units`. */
  releaseHold(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    units: Decimal,
    kind: HoldKind,
  ): void {
    this.mutateHolds(employeeId, locationId, leaveTypeId, (holds) =>
      HoldAccountant.apply(holds, kind, units.neg()),
    );
  }

  /** Atomic move of `units` between buckets (saga's PENDING → APPROVED step). */
  promoteHold(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    units: Decimal,
    from: HoldKind,
    to: HoldKind,
  ): void {
    this.mutateHolds(employeeId, locationId, leaveTypeId, (holds) =>
      HoldAccountant.promote(holds, from, to, units),
    );
  }

  /**
   * Converge on an HCM-sourced row. Inserts when missing, updates when newer.
   * Returns `true` when local state advanced. `RECONCILING` is preserved; on
   * any other prior state, transitions to `UNDER_HOLD_DEFICIT` if the new
   * `available` is below current total holds, else `SYNCED`.
   */
  applyHcmUpdate(snapshot: BalanceSnapshot): boolean {
    return this.db.transaction((): boolean => {
      const existing = this.store.find(
        snapshot.employeeId,
        snapshot.locationId,
        snapshot.leaveTypeId,
      );
      const now = new Date().toISOString();

      if (existing === null) {
        this.store.insert({
          employeeId: snapshot.employeeId,
          locationId: snapshot.locationId,
          leaveTypeId: snapshot.leaveTypeId,
          available: snapshot.available,
          hcmVersion: snapshot.hcmVersion,
          hcmEffectiveAt: snapshot.hcmEffectiveAt,
          at: now,
          state: 'SYNCED', // zero holds — cannot be deficit on insert
        });
        return true;
      }

      if (snapshot.hcmVersion <= existing.hcmVersion) return false;

      this.store.updateAvailable({
        employeeId: snapshot.employeeId,
        locationId: snapshot.locationId,
        leaveTypeId: snapshot.leaveTypeId,
        available: snapshot.available,
        hcmVersion: snapshot.hcmVersion,
        hcmEffectiveAt: snapshot.hcmEffectiveAt,
        at: now,
        state: derive(existing.state, snapshot.available, existing.holds),
      });
      return true;
    })();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private mutateHolds(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    transform: (holds: Holds) => Holds,
  ): void {
    this.db.transaction(() => {
      const existing = this.store.find(employeeId, locationId, leaveTypeId);
      if (existing === null) {
        throw new Error(
          `BalanceService: no balance exists for (${employeeId}, ${locationId}, ${leaveTypeId})`,
        );
      }
      const updatedHolds = transform(existing.holds);
      this.store.updateHolds({
        employeeId,
        locationId,
        leaveTypeId,
        holds: updatedHolds,
        at: new Date().toISOString(),
        state: derive(existing.state, existing.available, updatedHolds),
      });
    })();
  }
}

/**
 * Pure state-machine derivation. `RECONCILING` is owned by the reconciler;
 * any other prior state collapses to `UNDER_HOLD_DEFICIT` or `SYNCED` based
 * on whether the deficit invariant holds. `STALE` is set by the staleness
 * sweeper (future slice) and reset on any HCM update — handled here as
 * "anything not RECONCILING/STALE returns to SYNCED unless deficit."
 */
function derive(prior: BalanceState, available: Decimal, holds: Holds): BalanceState {
  if (prior === 'RECONCILING') return 'RECONCILING';
  return HoldAccountant.isDeficit(available, holds) ? 'UNDER_HOLD_DEFICIT' : 'SYNCED';
}
