import { Controller, Get, Param } from '@nestjs/common';
import { LeaveTypeStore } from '../persistence/leave-type.store';

/** Implements `GET /leaveTypes/:locationId` per TRD §17.2. */
@Controller('leaveTypes')
export class LeaveTypesController {
  constructor(private readonly leaveTypes: LeaveTypeStore) {}

  @Get(':locationId')
  fetch(@Param('locationId') locationId: string) {
    return {
      locationId,
      leaveTypes: this.leaveTypes.listForLocation(locationId).map((row) => ({
        leaveTypeId: row.leaveTypeId,
        isActive: row.isActive,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        hcmVersion: row.hcmVersion.toString(),
      })),
    };
  }
}
