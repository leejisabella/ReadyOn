import { Controller, Get, Param } from '@nestjs/common';
import { EmployeeStore } from '../persistence/employee.store';
import { EmploymentStore } from '../persistence/employment.store';
import { HcmHttpError } from '../common/hcm-http-error';

/** Implements `GET /employees/:employeeId` per TRD §17.2 (used by lazy bootstrap). */
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employees: EmployeeStore,
    private readonly employment: EmploymentStore,
  ) {}

  @Get(':employeeId')
  fetch(@Param('employeeId') employeeId: string) {
    const employee = this.employees.find(employeeId);
    if (!employee) {
      throw new HcmHttpError(404, 'EMPLOYEE_NOT_FOUND', `Unknown employee ${employeeId}.`);
    }
    return {
      employeeId: employee.employeeId,
      hcmVersion: employee.hcmVersion.toString(),
      employment: this.employment.listForEmployee(employeeId).map((p) => ({
        locationId: p.locationId,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo,
        hcmVersion: p.hcmVersion.toString(),
      })),
    };
  }
}
