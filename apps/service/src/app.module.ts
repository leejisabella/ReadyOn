import { DynamicModule, Module } from '@nestjs/common';
import { ApiModule } from './api/api.module';
import { ConfigModule } from './infrastructure/config/config.module';
import type { ServiceConfig } from './infrastructure/config/service-config';
import { HcmAdapterModule } from './infrastructure/hcm/hcm-adapter.module';
import { DatabaseModule } from './infrastructure/persistence/database.module';

/**
 * Root module of the ReadyOn Time-Off service.
 *
 * Takes a fully-parsed {@link ServiceConfig} and threads slices of it into
 * each child module's `.forRoot` — env-var translation lives in `main.ts`
 * (via `loadConfig`), not here.
 *
 * @ref docs/04_Module_Plan.md §2
 */
@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule.forRoot({ dbPath: config.server.dbPath }),
        HcmAdapterModule.forRoot({
          adapter: { baseUrl: config.hcm.baseUrl, timeoutMs: config.hcm.timeoutMs },
          healthMonitor: {
            unhealthyAfterFailures: config.hcm.unhealthyAfterFailures,
            healthyAfterMs: config.hcm.healthyAfterMs,
          },
        }),
        ApiModule.forRoot({
          request: { breakGlass: config.breakGlass },
          reconciliation: {
            provisionalReconciler: {
              historyQueryWindowMs: config.reconciler.historyQueryWindowMs,
              staleAfterMs: config.reconciler.staleAfterMs,
              leaseTtlMs: config.reconciler.leaseTtlMs,
            },
            driftSweep: { staleAfterMs: config.reconciliation.staleBalanceThresholdMs },
          },
          hrReviewQueue: {
            cancellationStuckAfterMs: config.cancellation.pendingAlertThresholdMs,
          },
        }),
      ],
    };
  }
}
