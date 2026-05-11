import { Inject, Injectable } from '@nestjs/common';
import type { HcmPort } from '@time-off/hcm-port';
import { BalanceService } from '../../domain/balance/balance.service';
import { HCM_PORT } from '../hcm/hcm-adapter.module';

export interface BatchReconciliationResult {
  /** Total rows streamed from HCM. */
  readonly inspected: number;
  /** Rows whose `hcmVersion` was strictly greater than ours — local state advanced. */
  readonly applied: number;
  /** Rows whose `hcmVersion` was already ≤ ours — silent no-op. */
  readonly skipped: number;
}

/**
 * Daily catch-all. Streams the full HCM balance corpus and applies each
 * entry through {@link BalanceService.applyHcmUpdate}, which is itself
 * `hcmVersion`-gated — stale rows from a long batch run silently no-op.
 *
 * Divergence classification (ANNIVERSARY_BUMP, RETRO_CORRECTION, etc.) is
 * a follow-up audit concern; this slice converges state and counts.
 *
 * @ref docs/01_TRD.md §10.2, §13.5
 * @ref docs/04_Module_Plan.md §3.15
 */
@Injectable()
export class BatchReconciliation {
  constructor(
    private readonly balance: BalanceService,
    @Inject(HCM_PORT) private readonly hcm: HcmPort,
  ) {}

  async tick(): Promise<BatchReconciliationResult> {
    let inspected = 0;
    let applied = 0;
    for await (const entry of this.hcm.fetchBatch()) {
      inspected += 1;
      const wasApplied = this.balance.applyHcmUpdate({
        employeeId: entry.employeeId,
        locationId: entry.locationId,
        leaveTypeId: entry.leaveTypeId,
        available: entry.available,
        hcmVersion: entry.hcmVersion,
        hcmEffectiveAt: entry.appliedAt,
      });
      if (wasApplied) applied += 1;
    }
    return { inspected, applied, skipped: inspected - applied };
  }
}
