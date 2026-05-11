import { DynamicModule, Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { BreakGlassModule } from '../break-glass/break-glass.module';
import type { BreakGlassAuthorizerOptions } from '../break-glass/break-glass.authorizer';
import { EmployeeBootstrapModule } from '../employee-bootstrap/employee-bootstrap.module';
import { EmploymentModule } from '../employment/employment.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { LeaveTypeAvailabilityModule } from '../leave-type-availability/leave-type-availability.module';
import { ProvisionalActionModule } from '../provisional-action/provisional-action.module';
import { RequestService } from './request.service';
import { RequestStore } from './request.store';

export interface RequestModuleOptions {
  readonly breakGlass?: BreakGlassAuthorizerOptions;
}

/**
 * The time-off request saga. Composes every domain module that contributes
 * to the lifecycle: employment for location attribution, leave-type
 * availability for pre-validation, bootstrap for unknown-employee handling,
 * balance for hold accounting, idempotency for retry safety, provisional
 * actions + break-glass authorizer for sustained-outage approvals.
 *
 * @ref docs/04_Module_Plan.md §3.2
 */
@Module({})
export class RequestModule {
  static forRoot(options: RequestModuleOptions = {}): DynamicModule {
    return {
      module: RequestModule,
      imports: [
        EmploymentModule,
        LeaveTypeAvailabilityModule,
        EmployeeBootstrapModule,
        BalanceModule,
        IdempotencyModule,
        ProvisionalActionModule,
        BreakGlassModule.forRoot(options.breakGlass ?? {}),
      ],
      providers: [RequestStore, RequestService],
      exports: [RequestService],
    };
  }
}
