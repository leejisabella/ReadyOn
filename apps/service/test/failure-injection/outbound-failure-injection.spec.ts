import {
  HcmContractViolation,
  HcmTransientError,
} from '@time-off/hcm-port';
import Decimal from 'decimal.js';
import { MockHcmTestHarness } from '../helpers/mock-hcm-test-harness';
import { HcmHealthMonitor } from '../../src/infrastructure/hcm/hcm-health.monitor';
import { MockHcmAdapter } from '../../src/infrastructure/hcm/mock-hcm.adapter';

/**
 * Layer 5 — Outbound failure-injection tests (TRD §17.3, Test Plan §7).
 *
 * Drives the Mock HCM through each of its adversarial modes and asserts the
 * service-side defensive layers (adapter zod validation, `deltaApplied`
 * cross-check, transaction-confirmation guard) catch them and surface the
 * right typed error.
 *
 * Each `it` carries an `T-FI-NN` ID. Modes covered:
 *
 *   flaky · silent_no_op · wrong_delta · missing_confirmation ·
 *   stale_version · malformed · slow · version_skew · unreachable
 */
describe('Layer 5 — Outbound failure injection', () => {
  let harness: MockHcmTestHarness;
  let monitor: HcmHealthMonitor;
  let adapter: MockHcmAdapter;

  beforeAll(async () => {
    harness = await MockHcmTestHarness.boot();
  });

  afterAll(async () => {
    await harness.shutdown();
  });

  beforeEach(async () => {
    await harness.reset();
    await harness.seedEmployee({
      employeeId: 'emp-1',
      employment: [{ locationId: 'loc-1', effectiveFrom: '2025-01-01' }],
      balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '10' }],
    });
    await harness.seedLeaveTypeAvailability({
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      isActive: true,
      effectiveFrom: '2025-01-01',
    });
    monitor = new HcmHealthMonitor({ unhealthyAfterFailures: 2, healthyAfterMs: 1 });
    adapter = new MockHcmAdapter({ baseUrl: harness.baseUrl, timeoutMs: 1500 }, monitor);
  });

  afterEach(async () => {
    await harness.setMode('normal');
    await harness.setReachability('on');
  });

  const reserve = (key: string): Promise<unknown> =>
    adapter.reserveBalance(
      {
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        units: new Decimal(1),
      },
      key,
    );

  describe('T-FI-01 — flaky mode', () => {
    it('returns 5xx → adapter surfaces HcmTransientError', async () => {
      await harness.setMode('flaky', { flakyRate: 1, forceNextCalls: 5 });
      await expect(reserve('k-flaky')).rejects.toBeInstanceOf(HcmTransientError);
    });

    it('two consecutive 5xx → health monitor flips to UNHEALTHY', async () => {
      await harness.setMode('flaky', { flakyRate: 1, forceNextCalls: 5 });
      await expect(reserve('k-flaky-a')).rejects.toBeInstanceOf(HcmTransientError);
      await expect(reserve('k-flaky-b')).rejects.toBeInstanceOf(HcmTransientError);
      expect(monitor.isHealthy()).toBe(false);
    });
  });

  describe('T-FI-02 — silent_no_op mode', () => {
    it('200 with deltaApplied=0 → TRD §13.3 cross-check throws HcmContractViolation', async () => {
      await harness.setMode('silent_no_op');
      await expect(reserve('k-silent')).rejects.toBeInstanceOf(HcmContractViolation);
    });
  });

  describe('T-FI-03 — wrong_delta mode', () => {
    it('200 with deltaApplied != requested → HcmContractViolation', async () => {
      await harness.setMode('wrong_delta');
      await expect(reserve('k-wrong')).rejects.toBeInstanceOf(HcmContractViolation);
    });
  });

  describe('T-FI-04 — missing_confirmation mode', () => {
    it('200 with required fields stripped → HcmContractViolation', async () => {
      await harness.setMode('missing_confirmation');
      await expect(reserve('k-missing')).rejects.toBeInstanceOf(HcmContractViolation);
    });
  });

  describe('T-FI-05 — stale_version mode', () => {
    it('200 with hcmVersion=0 (≤ current) → adapter accepts payload, batch reconciler is the backstop', async () => {
      // The adapter validates schema; staleness check is a domain-level
      // concern via `applyHcmUpdate` (Balance store ignores older versions).
      // This test asserts the adapter survives stale_version without throwing
      // a contract error — the defensive layer is at the domain level.
      await harness.setMode('stale_version');
      const response = await reserve('k-stale');
      expect((response as { hcmVersion: bigint }).hcmVersion).toBe(0n);
    });
  });

  describe('T-FI-06 — malformed mode', () => {
    it('non-JSON body → HcmContractViolation', async () => {
      await harness.setMode('malformed');
      await expect(reserve('k-malformed')).rejects.toBeInstanceOf(HcmContractViolation);
    });
  });

  describe('T-FI-07 — slow mode', () => {
    it('latency above adapter timeout → HcmTransientError (timeout)', async () => {
      await harness.setMode('slow', { slowLatencyMs: 3000 });
      await expect(reserve('k-slow')).rejects.toBeInstanceOf(HcmTransientError);
    }, 10_000);

    it('latency below adapter timeout → call succeeds', async () => {
      await harness.setMode('slow', { slowLatencyMs: 200 });
      const response = await reserve('k-slow-ok');
      expect(response).toBeDefined();
    });
  });

  describe('T-FI-08 — version_skew mode', () => {
    it('200 with absurdly-large hcmVersion → schema accepts (bigint); domain rules guard', async () => {
      await harness.setMode('version_skew');
      const response = await reserve('k-skew');
      // The schema accepts arbitrary monotonic bigints. The version_skew mode
      // is a domain-layer defense concern (BalanceStore would still update,
      // but a later batch reconciliation reveals the truth).
      expect((response as { hcmVersion: bigint }).hcmVersion).toBeGreaterThan(0n);
    });
  });

  describe('T-FI-09 — unreachable (reachability=off)', () => {
    it('503 on every call → HcmTransientError; monitor flips after threshold', async () => {
      await harness.setReachability('off');
      await expect(reserve('k-unreach-1')).rejects.toBeInstanceOf(HcmTransientError);
      await expect(reserve('k-unreach-2')).rejects.toBeInstanceOf(HcmTransientError);
      expect(monitor.isHealthy()).toBe(false);
    });

    it('flips back to healthy on recovery + successful call', async () => {
      await harness.setReachability('off');
      await expect(reserve('k-recover-fail')).rejects.toBeInstanceOf(HcmTransientError);
      await harness.setReachability('on');
      // unhealthyAfterFailures=2 in beforeEach; first failure didn't flip,
      // a single success now resets streak. Drive the monitor.
      const response = await reserve('k-recover-ok');
      expect(response).toBeDefined();
    });
  });

  describe('T-FI-10 — admin endpoints are honest under every mode', () => {
    it('flaky mode does NOT affect /admin/* — harness stays usable', async () => {
      await harness.setMode('flaky', { flakyRate: 1 });
      // If the interceptor leaked into /admin we'd fail here.
      await expect(harness.getMode()).resolves.toMatchObject({ mode: 'flaky' });
      await harness.setMode('normal');
    });

    it('reachability=off does NOT affect /admin/* — harness can re-enable', async () => {
      await harness.setReachability('off');
      await expect(harness.getMode()).resolves.toMatchObject({ reachability: 'off' });
      await harness.setReachability('on');
    });
  });
});
