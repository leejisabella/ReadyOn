import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { EmployeeBootstrapModule } from '../employee-bootstrap/employee-bootstrap.module';
import { EmploymentModule } from '../employment/employment.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { LeaveTypeAvailabilityModule } from '../leave-type-availability/leave-type-availability.module';
import { RequestService } from './request.service';
import { RequestStore } from './request.store';

/**
 * The time-off request saga. Composes every domain module that contributes
 * to the lifecycle: employment for location attribution, leave-type
 * availability for pre-validation, bootstrap for unknown-employee handling,
 * balance for hold accounting, idempotency for retry safety.
 *
 * @ref docs/04_Module_Plan.md §3.2
 */
@Module({
  imports: [
    EmploymentModule,
    LeaveTypeAvailabilityModule,
    EmployeeBootstrapModule,
    BalanceModule,
    IdempotencyModule,
  ],
  providers: [RequestStore, RequestService],
  exports: [RequestService],
})
export class RequestModule {}
