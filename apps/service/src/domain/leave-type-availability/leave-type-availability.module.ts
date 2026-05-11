import { Module } from '@nestjs/common';
import { LeaveTypeAvailabilityService } from './leave-type-availability.service';
import { LeaveTypeAvailabilityStore } from './leave-type-availability.store';

/**
 * Owns the local `(location, leaveType)` validity projection. Consumed by
 * the request saga as a cheap local pre-check and by the inbox processor as
 * a `LEAVE_TYPE_CHANGED` sink.
 *
 * @ref docs/04_Module_Plan.md §3.5
 */
@Module({
  providers: [LeaveTypeAvailabilityStore, LeaveTypeAvailabilityService],
  exports: [LeaveTypeAvailabilityService],
})
export class LeaveTypeAvailabilityModule {}
