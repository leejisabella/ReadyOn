import { Module } from '@nestjs/common';
import { EmploymentModule } from '../employment/employment.module';
import { EmployeeBootstrapService } from './employee-bootstrap.service';
import { EmployeeStore } from './employee.store';

/**
 * Three-path bootstrap (webhook + lazy-pull + batch). Depends on
 * {@link EmploymentModule} for employment-row insertion. The HCM adapter is
 * a global provider, so no explicit import is needed.
 *
 * @ref docs/04_Module_Plan.md §3.6
 */
@Module({
  imports: [EmploymentModule],
  providers: [EmployeeStore, EmployeeBootstrapService],
  exports: [EmployeeBootstrapService],
})
export class EmployeeBootstrapModule {}
