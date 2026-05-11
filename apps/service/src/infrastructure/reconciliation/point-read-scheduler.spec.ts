import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { OutboxStore } from '../outbox/outbox.store';
import { PointReadScheduler } from './point-read-scheduler.service';

/** Deterministic clock + RNG so jitter math is testable. */
class FakeClock {
  private t = 1_000_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

describe('PointReadScheduler', () => {
  let db: Database;
  let outbox: OutboxStore;
  let clock: FakeClock;

  beforeEach(() => {
    db = makeServiceTestDb();
    outbox = new OutboxStore(db);
    clock = new FakeClock();
  });

  afterEach(() => db.close());

  function makeScheduler(opts: Partial<{ jitter: number; maxPerTick: number; delay: number }> = {}): PointReadScheduler {
    return new PointReadScheduler(outbox, {
      delayMs: opts.delay ?? 30_000,
      jitterMs: opts.jitter ?? 5_000,
      maxPerTick: opts.maxPerTick ?? 10,
      now: clock.now,
      random: () => 0, // no jitter for determinism unless overridden
    });
  }

  describe('schedule (coalescing per TRD §10.4)', () => {
    it('schedules a single entry per balance key', () => {
      const s = makeScheduler();
      s.schedule('emp-1', 'loc-1', 'pto');
      expect(s.pendingCount()).toBe(1);
    });

    it('is a no-op for a key that is already scheduled', () => {
      const s = makeScheduler();
      s.schedule('emp-1', 'loc-1', 'pto');
      s.schedule('emp-1', 'loc-1', 'pto');
      s.schedule('emp-1', 'loc-1', 'pto');
      expect(s.pendingCount()).toBe(1);
    });

    it('distinguishes different (employee, location, leaveType) tuples', () => {
      const s = makeScheduler();
      s.schedule('emp-1', 'loc-1', 'pto');
      s.schedule('emp-1', 'loc-1', 'sick');
      s.schedule('emp-1', 'loc-2', 'pto');
      s.schedule('emp-2', 'loc-1', 'pto');
      expect(s.pendingCount()).toBe(4);
    });
  });

  describe('tick (drain + rate limit)', () => {
    it('fires due entries and enqueues FETCH_BALANCE in the outbox', () => {
      const s = makeScheduler({ delay: 10 });
      s.schedule('emp-1', 'loc-1', 'pto');
      clock.advance(11);
      const result = s.tick();
      expect(result.fired).toBe(1);
      expect(result.scheduled).toBe(0);
      const queue = outbox.listByState('PENDING');
      expect(queue).toHaveLength(1);
      expect(queue[0]?.type).toBe('FETCH_BALANCE');
      expect(queue[0]?.payload).toEqual({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto' });
    });

    it('does not fire entries whose scheduled time has not arrived', () => {
      const s = makeScheduler({ delay: 1000 });
      s.schedule('emp-1', 'loc-1', 'pto');
      clock.advance(500);
      const result = s.tick();
      expect(result.fired).toBe(0);
      expect(result.scheduled).toBe(1);
    });

    it('caps fires at maxPerTick — excess due entries stay scheduled and fire on subsequent ticks', () => {
      const s = makeScheduler({ delay: 10, maxPerTick: 2 });
      for (let i = 0; i < 5; i += 1) {
        s.schedule(`emp-${i}`, 'loc-1', 'pto');
      }
      clock.advance(11);

      const first = s.tick();
      expect(first.fired).toBe(2);
      expect(first.deferred).toBe(3);
      expect(s.pendingCount()).toBe(3);

      const second = s.tick();
      expect(second.fired).toBe(2);
      expect(s.pendingCount()).toBe(1);

      const third = s.tick();
      expect(third.fired).toBe(1);
      expect(s.pendingCount()).toBe(0);
    });

    it('jitter spreads schedules deterministically when random is seeded', () => {
      const rolls = [0.0, 0.5, 1.0];
      const random = (): number => rolls.shift() ?? 0;
      const s = new PointReadScheduler(outbox, {
        delayMs: 100,
        jitterMs: 1000,
        maxPerTick: 10,
        now: clock.now,
        random,
      });
      s.schedule('emp-1', 'loc-1', 'pto');
      s.schedule('emp-1', 'loc-2', 'pto');
      s.schedule('emp-1', 'loc-3', 'pto');
      // The earliest-scheduled (jitter 0 → +100ms) fires first when only that
      // entry's time has arrived.
      clock.advance(100);
      let result = s.tick();
      expect(result.fired).toBe(1);
      // After advancing past +600ms (the second's schedule), it fires.
      clock.advance(500);
      result = s.tick();
      expect(result.fired).toBe(1);
      // The third (+1099ms) needs the full window.
      clock.advance(500);
      result = s.tick();
      expect(result.fired).toBe(1);
    });
  });
});
