import { Controller, Get, Param } from '@nestjs/common';
import { EmployeeStore } from '../persistence/employee.store';
import { EmploymentStore } from '../persistence/employment.store';
import { HcmHttpError } from '../common/hcm-http-error';

/** Implements `GET /employment/:employeeId` per TRD §17.2. */
@Controller('employment')
export class EmploymentController {
  constructor(
    private readonly employees: EmployeeStore,
    private readonly employment: EmploymentStore,
  ) {}

  @Get(':employeeId')
  fetch(@Param('employeeId') employeeId: string) {
    if (!this.employees.find(employeeId)) {
      throw new HcmHttpError(404, 'EMPLOYEE_NOT_FOUND', `Unknown employee ${employeeId}.`);
    }
    return {
      employeeId,
      periods: this.employment.listForEmployee(employeeId).map((p) => ({
        locationId: p.locationId,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo,
        hcmVersion: p.hcmVersion.toString(),
      })),
    };
  }
}
