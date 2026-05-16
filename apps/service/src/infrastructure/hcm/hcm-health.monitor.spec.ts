import { HcmHealthMonitor } from './hcm-health.monitor';

/** Deterministic clock: starts at 0, advances only when `advance(ms)` is called. */
class FakeClock {
  private t = 0;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

const fastConfig = (clock: FakeClock) => ({
  unhealthyAfterFailures: 3,
  healthyAfterMs: 1000,
  now: clock.now,
});

describe('HcmHealthMonitor', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock();
  });

  describe('initial state', () => {
    it('starts HEALTHY with no outage', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      expect(m.isHealthy()).toBe(true);
      expect(m.outageStartedAt()).toBeNull();
      expect(m.outageDuration()).toBe(0);
    });
  });

  describe('flip to UNHEALTHY', () => {
    it('stays HEALTHY when consecutive failures are below the threshold', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      m.recordFailure('transient');
      m.recordFailure('transient');
      expect(m.isHealthy()).toBe(true);
    });

    it('flips to UNHEALTHY at exactly the threshold and records outageStartedAt', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      clock.advance(500);
      m.recordFailure('transient');
      m.recordFailure('transient');
      m.recordFailure('transient');
      expect(m.isHealthy()).toBe(false);
      expect(m.outageStartedAt()).toEqual(new Date(500));
    });

    it('treats permanent failures the same as transient for the threshold', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      m.recordFailure('permanent');
      m.recordFailure('transient');
      m.recordFailure('permanent');
      expect(m.isHealthy()).toBe(false);
    });

    it('a success resets the failure counter — three failures with a gap remain HEALTHY', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      m.recordFailure('transient');
      m.recordFailure('transient');
      m.recordSuccess(); // resets counter
      m.recordFailure('transient');
      m.recordFailure('transient');
      expect(m.isHealthy()).toBe(true);
    });
  });

  describe('recovery (hysteresis)', () => {
    function takeDown(m: HcmHealthMonitor): void {
      m.recordFailure('transient');
      m.recordFailure('transient');
      m.recordFailure('transient');
    }

    it('a single success does NOT flip back when healthyAfterMs has not elapsed', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      takeDown(m);
      m.recordSuccess();
      expect(m.isHealthy()).toBe(false);
    });

    it('flips back to HEALTHY once healthyAfterMs of successes accumulates', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      takeDown(m);
      m.recordSuccess();
      clock.advance(999);
      m.recordSuccess();
      expect(m.isHealthy()).toBe(false);
      clock.advance(1);
      m.recordSuccess();
      expect(m.isHealthy()).toBe(true);
      expect(m.outageStartedAt()).toBeNull();
    });

    it('a failure during the recovery window restarts the clock', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      takeDown(m);
      m.recordSuccess();
      clock.advance(900);
      m.recordFailure('transient'); // restart window
      m.recordSuccess();
      clock.advance(900);
      m.recordSuccess();
      expect(m.isHealthy()).toBe(false); // 900ms since last reset, threshold is 1000ms
      clock.advance(101);
      m.recordSuccess();
      expect(m.isHealthy()).toBe(true);
    });
  });

  describe('outageDuration', () => {
    it('is zero while HEALTHY', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      m.recordFailure('transient');
      expect(m.outageDuration()).toBe(0);
    });

    it('reports elapsed ms once UNHEALTHY', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      m.recordFailure('transient');
      m.recordFailure('transient');
      m.recordFailure('transient');
      clock.advance(7_500);
      expect(m.outageDuration()).toBe(7_500);
    });
  });

  describe('onStateChange', () => {
    it('fires once per HEALTHY↔UNHEALTHY transition, not per outcome, and resetForTest restores listener semantics', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      const states: string[] = [];
      m.onStateChange((s) => states.push(s));

      m.recordFailure('transient');
      m.recordFailure('transient');
      expect(states).toEqual([]);
      m.recordFailure('transient');
      expect(states).toEqual(['UNHEALTHY']);
      // Outage start is captured at the first flip and must not move on
      // further failures while already UNHEALTHY.
      const firstOutageStart = m.outageStartedAt();
      expect(firstOutageStart).toEqual(new Date(0));

      m.recordFailure('transient');
      expect(states).toEqual(['UNHEALTHY']); // no double-fire
      clock.advance(5_000);
      m.recordFailure('transient');
      expect(m.outageStartedAt()).toEqual(firstOutageStart); // unchanged

      m.recordSuccess();
      clock.advance(2_000);
      m.recordSuccess();
      expect(states).toEqual(['UNHEALTHY', 'HEALTHY']);

      // resetForTest while HEALTHY must NOT notify; while UNHEALTHY it must.
      m.resetForTest();
      expect(states).toEqual(['UNHEALTHY', 'HEALTHY']); // unchanged
      m.recordFailure('transient');
      m.recordFailure('transient');
      m.recordFailure('transient');
      expect(states).toEqual(['UNHEALTHY', 'HEALTHY', 'UNHEALTHY']);
      m.resetForTest();
      expect(states).toEqual(['UNHEALTHY', 'HEALTHY', 'UNHEALTHY', 'HEALTHY']);
      expect(m.outageStartedAt()).toBeNull();
    });

    it('unsubscribe stops subsequent notifications', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      const states: string[] = [];
      const unsub = m.onStateChange((s) => states.push(s));

      m.recordFailure('transient');
      m.recordFailure('transient');
      m.recordFailure('transient');
      expect(states).toEqual(['UNHEALTHY']);

      unsub();
      m.recordSuccess();
      clock.advance(2_000);
      m.recordSuccess();
      expect(states).toEqual(['UNHEALTHY']);
    });

    it('supports multiple independent subscribers', () => {
      const m = new HcmHealthMonitor(fastConfig(clock));
      const a: string[] = [];
      const b: string[] = [];
      m.onStateChange((s) => a.push(s));
      m.onStateChange((s) => b.push(s));
      m.recordFailure('transient');
      m.recordFailure('transient');
      m.recordFailure('transient');
      expect(a).toEqual(['UNHEALTHY']);
      expect(b).toEqual(['UNHEALTHY']);
    });
  });
});
