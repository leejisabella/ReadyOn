import { Injectable } from '@nestjs/common';
import {
  LeaveTypeAvailabilityStore,
  type LeaveTypeAvailabilityPeriod,
} from './leave-type-availability.store';

export interface LeaveTypeAvailabilitySnapshot {
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
  readonly hcmVersion: bigint;
}

/**
 * Projection of which `(locationId, leaveTypeId)` pairs are valid at a given
 * date. The request-creation saga calls {@link isActive} as the cheap local
 * pre-check (TRD §9.1 step 4); the inbox processor feeds `LEAVE_TYPE_CHANGED`
 * events through {@link applyHcmUpdate}.
 *
 * @ref docs/01_TRD.md §5.4
 * @ref docs/04_Module_Plan.md §3.5
 */
@Injectable()
export class LeaveTypeAvailabilityService {
  constructor(private readonly store: LeaveTypeAvailabilityStore) {}

  /**
   * `true` iff the pair `(locationId, leaveTypeId)` has a covering period
   * on `asOfDate` whose `is_active = true`. Returns `false` for unknown
   * pairs, gap dates, and explicitly-deactivated periods.
   */
  isActive(locationId: string, leaveTypeId: string, asOfDate: string): boolean {
    return this.store.findActiveAt(locationId, leaveTypeId, asOfDate)?.isActive === true;
  }

  listForLocation(locationId: string): LeaveTypeAvailabilityPeriod[] {
    return this.store.listForLocation(locationId);
  }

  /** See {@link EmploymentService.applyHcmUpdate} — same convergence contract. */
  applyHcmUpdate(snapshot: LeaveTypeAvailabilitySnapshot): boolean {
    return this.store.applyIfNewer(snapshot);
  }
}
