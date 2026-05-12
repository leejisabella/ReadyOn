import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { EmploymentService } from '../../domain/employment/employment.service';
import { LeaveTypeAvailabilityService } from '../../domain/leave-type-availability/leave-type-availability.service';
import { IsoDate } from "../scalars/iso-date.scalar";
import { EmploymentPeriodType } from '../types/employment-period.type';
import { LeaveTypeOptionType } from '../types/leave-type-option.type';

@Resolver()
export class EmploymentResolver {
  constructor(
    private readonly employmentService: EmploymentService,
    private readonly leaveTypes: LeaveTypeAvailabilityService,
  ) {}

  @Query(() => [EmploymentPeriodType], {
    description: 'Full employment timeline for the employee, in effectiveFrom order.',
  })
  employment(@Args('employeeId', { type: () => ID }) employeeId: string): EmploymentPeriodType[] {
    return this.employmentService.history(employeeId).map((p) => ({
      employeeId,
      locationId: p.locationId,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
      hcmVersion: p.hcmVersion.toString(),
    }));
  }

  @Query(() => [LeaveTypeOptionType], {
    description: 'Leave types active at the employee\'s location on the as-of date.',
  })
  leaveTypesAvailableAt(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('asOf', { type: () => IsoDate }) asOf: string,
  ): LeaveTypeOptionType[] {
    const locationId = this.employmentService.locationAt(employeeId, asOf);
    if (locationId === null) return [];
    return this.leaveTypes
      .listForLocation(locationId)
      .filter((p) => p.isActive && p.effectiveFrom <= asOf && (p.effectiveTo === null || p.effectiveTo >= asOf))
      .map((p) => ({
        leaveTypeId: p.leaveTypeId,
        locationId,
        isActive: p.isActive,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo,
      }));
  }
}
