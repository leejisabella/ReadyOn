import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { BalanceModule } from '../domain/balance/balance.module';
import { EmploymentModule } from '../domain/employment/employment.module';
import { HrReviewQueueModule } from '../domain/hr-review-queue/hr-review-queue.module';
import { LeaveTypeAvailabilityModule } from '../domain/leave-type-availability/leave-type-availability.module';
import { ProvisionalActionModule } from '../domain/provisional-action/provisional-action.module';
import {
  RequestModule,
  type RequestModuleOptions,
} from '../domain/request/request.module';
import { RequestStore } from '../domain/request/request.store';
import { ReconciliationModule } from '../infrastructure/reconciliation/reconciliation.module';
import { DomainErrorFilter } from './errors/domain-error.filter';
import { AdminResolver } from './resolvers/admin.resolver';
import { BalanceResolver } from './resolvers/balance.resolver';
import { EmploymentResolver } from './resolvers/employment.resolver';
import { HcmHealthResolver } from './resolvers/hcm-health.resolver';
import { HrReviewQueueResolver } from './resolvers/hr-review-queue.resolver';
import { ProvisionalActionResolver } from './resolvers/provisional-action.resolver';
import { TimeOffRequestResolver } from './resolvers/time-off-request.resolver';
import { DateTimeScalar } from './scalars/date-time.scalar';
import { DecimalScalar } from './scalars/decimal.scalar';
import { IsoDateScalar } from './scalars/iso-date.scalar';

export interface ApiModuleOptions {
  readonly request?: RequestModuleOptions;
  /** Path under which the GraphQL schema is generated for inspection. */
  readonly autoSchemaFile?: string | true;
}

/**
 * Composes every domain module that the resolvers depend on, registers
 * Apollo with a code-first schema, and installs the {@link DomainErrorFilter}
 * application-wide so any `DomainError` becomes a typed `GraphQLError`.
 *
 * @ref docs/01_TRD.md §7
 * @ref docs/04_Module_Plan.md §3.18
 */
@Module({})
export class ApiModule {
  static forRoot(options: ApiModuleOptions = {}): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        BalanceModule,
        EmploymentModule,
        LeaveTypeAvailabilityModule,
        ProvisionalActionModule,
        HrReviewQueueModule.forRoot(),
        RequestModule.forRoot(options.request ?? {}),
        ReconciliationModule.forRoot(),
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: options.autoSchemaFile ?? true,
          playground: false,
          context: ({ req }: { req: unknown }) => ({ req }),
        }),
      ],
      providers: [
        DecimalScalar,
        DateTimeScalar,
        IsoDateScalar,
        RequestStore,
        TimeOffRequestResolver,
        BalanceResolver,
        EmploymentResolver,
        HcmHealthResolver,
        ProvisionalActionResolver,
        HrReviewQueueResolver,
        AdminResolver,
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }
}
