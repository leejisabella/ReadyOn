import { Inject, Injectable } from '@nestjs/common';
import { BalanceService } from '../../domain/balance/balance.service';
import { PointReadScheduler } from './point-read-scheduler.service';

export interface DriftSweepOptions {
  /** Balances whose `lastReconciledAt` precedes `now - staleAfterMs` are swept. */
  readonly staleAfterMs?: number;
  /** Defensive cap on rows processed per tick. Default 1000. */
  readonly perTickLimit?: number;
  /** Test seam. */
  readonly now?: () => number;
}

export interface DriftSweepResult {
  readonly inspected: number;
  readonly scheduled: number;
  readonly skippedReconciling: number;
}

/**
 * Periodic backstop. Walks balances older than the stale threshold and
 * schedules a point-read for each. Skips rows already in `RECONCILING` —
 * the active reconciler will produce fresher data.
 *
 * @ref docs/01_TRD.md §13.5, §16 (reconciliation.staleBalanceThresholdMs)
 * @ref docs/04_Module_Plan.md §3.15
 */
@Injectable()
export class DriftSweep {
  private readonly staleAfterMs: number;
  private readonly perTickLimit: number;
  private readonly now: () => number;

  constructor(
    private readonly balance: BalanceService,
    private readonly scheduler: PointReadScheduler,
    @Inject('DRIFT_SWEEP_OPTIONS') options: DriftSweepOptions,
  ) {
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    this.perTickLimit = options.perTickLimit ?? 1000;
    this.now = options.now ?? Date.now;
  }

  tick(): DriftSweepResult {
    const cutoff = new Date(this.now() - this.staleAfterMs).toISOString();
    const stale = this.balance.listStale(cutoff, this.perTickLimit);
    let scheduled = 0;
    let skippedReconciling = 0;
    for (const row of stale) {
      if (row.state === 'RECONCILING') {
        skippedReconciling += 1;
        continue;
      }
      this.scheduler.schedule(row.employeeId, row.locationId, row.leaveTypeId);
      scheduled += 1;
    }
    return { inspected: stale.length, scheduled, skippedReconciling };
  }
}
