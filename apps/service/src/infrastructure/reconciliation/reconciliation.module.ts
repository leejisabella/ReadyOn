import { DynamicModule, Module } from '@nestjs/common';
import { BalanceModule } from '../../domain/balance/balance.module';
import { OutboxModule } from '../outbox/outbox.module';
import {
  BatchReconciliation,
} from './batch-reconciliation.service';
import { DriftSweep, type DriftSweepOptions } from './drift-sweep.service';
import {
  PointReadScheduler,
  type PointReadSchedulerOptions,
} from './point-read-scheduler.service';

export interface ReconciliationModuleOptions {
  readonly pointRead?: PointReadSchedulerOptions;
  readonly driftSweep?: DriftSweepOptions;
}

/**
 * Three independent cadences (TRD §10.4, §13.5):
 *
 *   - {@link PointReadScheduler} — burst-protected after-commit refresh.
 *   - {@link DriftSweep}          — periodic walk over stale balances.
 *   - {@link BatchReconciliation} — daily drain of HCM's full corpus.
 *
 * @ref docs/04_Module_Plan.md §3.15
 */
@Module({})
export class ReconciliationModule {
  static forRoot(options: ReconciliationModuleOptions = {}): DynamicModule {
    return {
      module: ReconciliationModule,
      imports: [BalanceModule, OutboxModule.forRoot()],
      providers: [
        { provide: 'POINT_READ_SCHEDULER_OPTIONS', useValue: options.pointRead ?? {} },
        { provide: 'DRIFT_SWEEP_OPTIONS', useValue: options.driftSweep ?? {} },
        PointReadScheduler,
        DriftSweep,
        BatchReconciliation,
      ],
      exports: [PointReadScheduler, DriftSweep, BatchReconciliation],
    };
  }
}
