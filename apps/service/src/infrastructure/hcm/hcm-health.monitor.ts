import { Injectable } from '@nestjs/common';

/**
 * Tracks HCM reachability with hysteresis.
 *
 * Optimistically starts `HEALTHY`. Flips to `UNHEALTHY` after
 * `unhealthyAfterFailures` consecutive `recordFailure` calls. Flips back to
 * `HEALTHY` once the time elapsed since the first uninterrupted success in
 * the current recovery window meets `healthyAfterMs`; any `recordFailure`
 * during the window restarts the clock.
 *
 * Pure in-memory state — process restart re-initializes to `HEALTHY` and
 * `outageStartedAt = null`. Persistence is intentionally out of scope.
 *
 * @ref docs/01_TRD.md §9.5.1, §16 (hcm.health* knobs)
 * @ref docs/02_Assumptions_and_Decisions.md ADR-011
 * @ref docs/04_Module_Plan.md §5.5
 */

export type HcmHealthState = 'HEALTHY' | 'UNHEALTHY';

export type HcmFailureCategory = 'transient' | 'permanent';

export type HealthStateListener = (state: HcmHealthState) => void;

export type Unsubscribe = () => void;

export interface HcmHealthMonitorOptions {
  /** Consecutive failures required to flip to UNHEALTHY. Default: 3. */
  readonly unhealthyAfterFailures?: number;
  /**
   * Duration of uninterrupted success (ms) required to flip back to HEALTHY.
   * Maps to TRD §16 `hcm.healthRecoveryWindowMs`. Default: 60_000.
   */
  readonly healthyAfterMs?: number;
  /** Injectable clock for deterministic tests. Default: `Date.now`. */
  readonly now?: () => number;
}

@Injectable()
export class HcmHealthMonitor {
  private readonly unhealthyAfterFailures: number;
  private readonly healthyAfterMs: number;
  private readonly now: () => number;

  private state: HcmHealthState = 'HEALTHY';
  private outageStarted: Date | null = null;
  private consecutiveFailures = 0;
  /** Timestamp of the first uninterrupted success in the current recovery window. */
  private recoveryWindowStartedAt: number | null = null;
  private readonly listeners = new Set<HealthStateListener>();

  constructor(opts: HcmHealthMonitorOptions = {}) {
    this.unhealthyAfterFailures = opts.unhealthyAfterFailures ?? 3;
    this.healthyAfterMs = opts.healthyAfterMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Reachable + responded — clears the failure counter and may close out a recovery window. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'HEALTHY') return;

    const nowMs = this.now();
    if (this.recoveryWindowStartedAt === null) {
      this.recoveryWindowStartedAt = nowMs;
    }
    if (nowMs - this.recoveryWindowStartedAt >= this.healthyAfterMs) {
      this.transition('HEALTHY');
      this.outageStarted = null;
      this.recoveryWindowStartedAt = null;
    }
  }

  /**
   * A call did not produce a usable answer. `category` is informational — both
   * variants count toward the unhealthy threshold and reset any in-progress
   * recovery window.
   */
  recordFailure(_category: HcmFailureCategory): void {
    this.recoveryWindowStartedAt = null;
    this.consecutiveFailures += 1;
    if (this.state === 'HEALTHY' && this.consecutiveFailures >= this.unhealthyAfterFailures) {
      this.outageStarted = new Date(this.now());
      this.transition('UNHEALTHY');
    }
  }

  isHealthy(): boolean {
    return this.state === 'HEALTHY';
  }

  outageStartedAt(): Date | null {
    return this.outageStarted;
  }

  /** Milliseconds since the outage started. Returns 0 when healthy. */
  outageDuration(): number {
    if (this.outageStarted === null) return 0;
    return this.now() - this.outageStarted.getTime();
  }

  /**
   * Subscribe to HEALTHY ↔ UNHEALTHY transitions. The listener fires only on
   * state changes, not on every recorded outcome. Returns an unsubscribe fn.
   */
  onStateChange(listener: HealthStateListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private transition(next: HcmHealthState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
