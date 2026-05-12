import type { ActorRole } from '../../domain/break-glass/break-glass.authorizer';

/**
 * Process-wide configuration. One `ServiceConfig` is produced at startup
 * from environment variables and threaded into every module's `.forRoot`.
 *
 * Only knobs that the code actively consumes appear here; the rest of
 * TRD §16 is documented in the spec and can be wired in when a feature
 * starts depending on it.
 *
 * @ref docs/01_TRD.md §16
 */
export interface ServiceConfig {
  /** HTTP server + SQLite location. */
  readonly server: {
    readonly port: number;
    readonly dbPath: string;
  };
  /** HCM adapter + health monitor. */
  readonly hcm: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly unhealthyAfterFailures: number;
    /** Maps to TRD §16 `hcm.healthRecoveryWindowMs`. */
    readonly healthyAfterMs: number;
  };
  /** Break-glass approval gate (TRD §16 `breakGlass.*`). */
  readonly breakGlass: {
    readonly minOutageMs: number;
    readonly requireRole: ActorRole;
  };
  /** Provisional reconciler tick (TRD §16 `reconciler.*`). */
  readonly reconciler: {
    readonly historyQueryWindowMs: number;
    readonly staleAfterMs: number;
    readonly leaseTtlMs: number;
  };
  /** Reconciliation cadences for non-provisional paths (TRD §16 `reconciliation.*`). */
  readonly reconciliation: {
    readonly staleBalanceThresholdMs: number;
  };
  /** HR review queue (TRD §16 `cancellation.pendingAlertThresholdMs`). */
  readonly cancellation: {
    readonly pendingAlertThresholdMs: number;
  };
}

/** DI token under which `ServiceConfig` is registered. */
export const SERVICE_CONFIG = 'SERVICE_CONFIG';
