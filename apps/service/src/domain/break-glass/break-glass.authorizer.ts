import { Inject, Injectable } from '@nestjs/common';
import { HcmHealthMonitor } from '../../infrastructure/hcm/hcm-health.monitor';

export type ActorRole = 'employee' | 'manager' | 'break_glass_approver' | 'hr_admin';

export interface AuthorizableActor {
  readonly actorRole: ActorRole;
}

export type AuthorizationResult =
  | { readonly kind: 'OK' }
  | { readonly kind: 'NOT_AUTHORIZED' }
  | { readonly kind: 'OUTAGE_THRESHOLD_NOT_MET'; readonly outageMs: number; readonly requiredMs: number }
  | { readonly kind: 'HCM_HEALTHY' };

export interface BreakGlassAuthorizerOptions {
  /** Role that gates break-glass invocation. TRD §16 default `break_glass_approver`. */
  readonly requireRole?: ActorRole;
  /** Minimum sustained outage before break-glass becomes available. TRD §16 default 60 000 ms. */
  readonly minOutageMs?: number;
}

/**
 * Pure gate for `approveTimeOffRequestProvisionally`. Order: role → HCM
 * health → outage duration. Each branch returns a distinct discriminator so
 * the saga can produce the right `DomainError` code (or just log the
 * "HCM_HEALTHY" attempt for observability).
 *
 * @ref docs/01_TRD.md §9.5.1, §16 (breakGlass.*)
 * @ref docs/04_Module_Plan.md §5.6
 */
@Injectable()
export class BreakGlassAuthorizer {
  private readonly requireRole: ActorRole;
  private readonly minOutageMs: number;

  constructor(
    private readonly health: HcmHealthMonitor,
    @Inject('BREAK_GLASS_OPTIONS') options: BreakGlassAuthorizerOptions = {},
  ) {
    this.requireRole = options.requireRole ?? 'break_glass_approver';
    this.minOutageMs = options.minOutageMs ?? 60_000;
  }

  authorize(actor: AuthorizableActor): AuthorizationResult {
    if (actor.actorRole !== this.requireRole) {
      return { kind: 'NOT_AUTHORIZED' };
    }
    if (this.health.isHealthy()) {
      return { kind: 'HCM_HEALTHY' };
    }
    const outageMs = this.health.outageDuration();
    if (outageMs < this.minOutageMs) {
      return { kind: 'OUTAGE_THRESHOLD_NOT_MET', outageMs, requiredMs: this.minOutageMs };
    }
    return { kind: 'OK' };
  }
}
