import { DynamicModule, Module } from '@nestjs/common';
import { BalanceModule } from '../../domain/balance/balance.module';
import { ProvisionalActionModule } from '../../domain/provisional-action/provisional-action.module';
import { RequestStore } from '../../domain/request/request.store';
import { OutboxModule } from '../outbox/outbox.module';
import {
  BatchReconciliation,
} from './batch-reconciliation.service';
import { DriftSweep, type DriftSweepOptions } from './drift-sweep.service';
import {
  PointReadScheduler,
  type PointReadSchedulerOptions,
} from './point-read-scheduler.service';
import {
  ProvisionalReconciler,
  type ProvisionalReconcilerOptions,
} from './provisional-reconciler.service';
import { ReconcilerLeaseStore } from './reconciler-lease.store';
import { ReconciliationStepStore } from './reconciliation-step.store';

export interface ReconciliationModuleOptions {
  readonly pointRead?: PointReadSchedulerOptions;
  readonly driftSweep?: DriftSweepOptions;
  readonly provisionalReconciler?: ProvisionalReconcilerOptions;
}

/**
 * Four independent cadences (TRD §9.5.3, §10.4, §13.5):
 *
 *   - {@link PointReadScheduler}    — burst-protected after-commit refresh.
 *   - {@link DriftSweep}            — periodic walk over stale balances.
 *   - {@link BatchReconciliation}   — daily drain of HCM's full corpus.
 *   - {@link ProvisionalReconciler} — drains break-glass actions on HCM recovery.
 *
 * @ref docs/04_Module_Plan.md §3.15, §3.16
 */
@Module({})
export class ReconciliationModule {
  static forRoot(options: ReconciliationModuleOptions = {}): DynamicModule {
    return {
      module: ReconciliationModule,
      imports: [BalanceModule, ProvisionalActionModule, OutboxModule.forRoot()],
      providers: [
        { provide: 'POINT_READ_SCHEDULER_OPTIONS', useValue: options.pointRead ?? {} },
        { provide: 'DRIFT_SWEEP_OPTIONS', useValue: options.driftSweep ?? {} },
        {
          provide: 'PROVISIONAL_RECONCILER_OPTIONS',
          useValue: options.provisionalReconciler ?? {},
        },
        PointReadScheduler,
        DriftSweep,
        BatchReconciliation,
        ReconcilerLeaseStore,
        ReconciliationStepStore,
        RequestStore,
        ProvisionalReconciler,
      ],
      exports: [
        PointReadScheduler,
        DriftSweep,
        BatchReconciliation,
        ReconcilerLeaseStore,
        ReconciliationStepStore,
        ProvisionalReconciler,
      ],
    };
  }
}
