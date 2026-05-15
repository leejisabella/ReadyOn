import { Injectable } from '@nestjs/common';

/**
 * Adversarial response modes per TRD §17.3. Each non-`normal` mode mutates a
 * response in a specific way; the service-side defensive layers (zod schema
 * validation, `deltaApplied` cross-check, transaction-confirmation guard,
 * point-read backstop) are responsible for catching them.
 *
 * Modes are global to the mock process — a single test fixture sets the mode
 * via {@link MockHcmTestHarness.setMode}; concurrent tests must serialize.
 *
 * @ref docs/01_TRD.md §17.3
 */
export type MockHcmMode =
  | 'normal'
  | 'flaky'
  | 'silent_no_op'
  | 'wrong_delta'
  | 'missing_confirmation'
  | 'stale_version'
  | 'malformed'
  | 'slow'
  | 'version_skew';

export type Reachability = 'on' | 'off';

export interface ModeConfig {
  readonly mode: MockHcmMode;
  /** flaky: 0..1, fraction of requests that fail with 5xx. */
  readonly flakyRate: number;
  /** slow: extra latency (ms) injected before responding. */
  readonly slowLatencyMs: number;
  /**
   * Deterministic countdown for tests: if > 0, the next N mutating responses
   * are forced to behave per the active mode regardless of `flakyRate`.
   * Decremented once per call until 0; tests use this for reproducibility.
   */
  readonly forceNextCalls: number;
  /** Reachability gate — global outage simulation. */
  readonly reachability: Reachability;
}

const DEFAULT: ModeConfig = {
  mode: 'normal',
  flakyRate: 0.5,
  slowLatencyMs: 0,
  forceNextCalls: 0,
  reachability: 'on',
};

/**
 * Single source of truth for the mock's current behavioural mode. Holds state
 * in-process (the mock is single-process; mode is a test-only signal).
 */
@Injectable()
export class ModeStore {
  private config: ModeConfig = DEFAULT;

  current(): ModeConfig {
    return this.config;
  }

  set(update: Partial<ModeConfig>): void {
    this.config = { ...this.config, ...update };
  }

  reset(): void {
    this.config = DEFAULT;
  }

  /**
   * Returns `true` and decrements the counter if a forced call is pending.
   * Otherwise returns `true` with probability `flakyRate` for `flaky` mode.
   * For all other non-`normal` modes, always returns `true` so the mode is
   * applied deterministically.
   */
  shouldApply(): boolean {
    if (this.config.mode === 'normal') return false;
    if (this.config.forceNextCalls > 0) {
      this.config = { ...this.config, forceNextCalls: this.config.forceNextCalls - 1 };
      return true;
    }
    if (this.config.mode === 'flaky') {
      return Math.random() < this.config.flakyRate;
    }
    return true;
  }
}
