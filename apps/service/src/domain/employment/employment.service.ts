import { Injectable } from '@nestjs/common';
import { EmploymentStore, type EmploymentPeriod } from './employment.store';

/**
 * Domain-typed input for an HCM-sourced employment update. The inbox
 * processor maps `EmploymentChangedEvent` payloads to this shape; the
 * domain service never references the HCM port's wire types directly.
 */
export interface EmploymentSnapshot {
  readonly employeeId: string;
  readonly locationId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly hcmVersion: bigint;
}

/**
 * Read-side projection of an employee's location timeline + the write path
 * that converges it on HCM-sourced events.
 *
 * Both interval endpoints are inclusive (TRD §12.3 — `locationAt(startDate)`
 * and `locationAt(endDate)` differ when a request straddles a transfer
 * boundary, so the boundary date itself must belong to exactly one period).
 *
 * @ref docs/01_TRD.md §5.3, §12.2
 * @ref docs/04_Module_Plan.md §3.4
 */
@Injectable()
export class EmploymentService {
  constructor(private readonly store: EmploymentStore) {}

  /**
   * The employee's assigned location on `asOfDate`. Returns `null` when no
   * period covers the date — before hire, in a gap between historical
   * periods, or after termination.
   */
  locationAt(employeeId: string, asOfDate: string): string | null {
    return this.store.findActiveAt(employeeId, asOfDate)?.locationId ?? null;
  }

  /** Full employment history, oldest period first. */
  history(employeeId: string): EmploymentPeriod[] {
    return this.store.listForEmployee(employeeId);
  }

  /**
   * Converge local state on an HCM-sourced row. Returns `true` when local
   * state changed (insert, or update at a newer `hcmVersion`), `false`
   * for stale replays. Callers gate downstream effects — most importantly
   * `RequestService.revalidateForEmployee` (Slice 9+) — on the return value.
   *
   * @ref docs/01_TRD.md §10.1 (hcmVersion is the ordering authority)
   */
  applyHcmUpdate(snapshot: EmploymentSnapshot): boolean {
    return this.store.applyIfNewer(snapshot);
  }
}
