import { HcmHealthMonitor } from '../../infrastructure/hcm/hcm-health.monitor';
import { BreakGlassAuthorizer } from './break-glass.authorizer';

describe('BreakGlassAuthorizer', () => {
  // Drive a deterministic clock for both the monitor and any outage math.
  let nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);
  const advance = (ms: number): void => {
    nowMs += ms;
  };

  let health: HcmHealthMonitor;
  let authorizer: BreakGlassAuthorizer;

  beforeEach(() => {
    nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);
    health = new HcmHealthMonitor({
      unhealthyAfterFailures: 1,
      healthyAfterMs: 60_000,
      now: () => nowMs,
    });
    authorizer = new BreakGlassAuthorizer(health, {
      requireRole: 'break_glass_approver',
      minOutageMs: 60_000,
    });
  });

  it('returns NOT_AUTHORIZED when the actor lacks break_glass_approver role', () => {
    expect(authorizer.authorize({ actorRole: 'manager' })).toEqual({ kind: 'NOT_AUTHORIZED' });
    expect(authorizer.authorize({ actorRole: 'employee' })).toEqual({ kind: 'NOT_AUTHORIZED' });
    expect(authorizer.authorize({ actorRole: 'hr_admin' })).toEqual({ kind: 'NOT_AUTHORIZED' });
  });

  it('returns HCM_HEALTHY when HCM is reachable — role check passes', () => {
    expect(authorizer.authorize({ actorRole: 'break_glass_approver' })).toEqual({
      kind: 'HCM_HEALTHY',
    });
  });

  it('returns OUTAGE_THRESHOLD_NOT_MET when HCM is down but outage is too short', () => {
    health.recordFailure('transient'); // monitor flips to UNHEALTHY at the current nowMs
    advance(30_000); // 30s outage, threshold is 60s
    const result = authorizer.authorize({ actorRole: 'break_glass_approver' });
    expect(result).toEqual({
      kind: 'OUTAGE_THRESHOLD_NOT_MET',
      outageMs: 30_000,
      requiredMs: 60_000,
    });
  });

  it('returns OK once role matches, HCM is unhealthy, and outage ≥ minOutageMs', () => {
    health.recordFailure('transient');
    advance(60_000); // exactly meets the threshold
    expect(authorizer.authorize({ actorRole: 'break_glass_approver' })).toEqual({ kind: 'OK' });
  });

  it('role check short-circuits before health/outage checks', () => {
    health.recordFailure('transient');
    advance(120_000); // outage exceeds threshold
    // wrong role still wins
    expect(authorizer.authorize({ actorRole: 'manager' })).toEqual({ kind: 'NOT_AUTHORIZED' });
  });

  it('honours defaults when options are omitted', () => {
    const defaulted = new BreakGlassAuthorizer(health, {});
    // role defaults to 'break_glass_approver'; HCM still HEALTHY → HCM_HEALTHY
    expect(defaulted.authorize({ actorRole: 'manager' })).toEqual({ kind: 'NOT_AUTHORIZED' });
    expect(defaulted.authorize({ actorRole: 'break_glass_approver' })).toEqual({
      kind: 'HCM_HEALTHY',
    });
  });
});
