import {
  HcmContractViolation,
  HcmEmployeeNotFoundError,
  HcmPermanentError,
  HcmTransientError,
} from '@time-off/hcm-port';
import Decimal from 'decimal.js';
import { MockHcmTestHarness } from '../../../test/helpers/mock-hcm-test-harness';
import { HcmHealthMonitor } from './hcm-health.monitor';
import { MockHcmAdapter } from './mock-hcm.adapter';

describe('MockHcmAdapter (integration via MockHcmTestHarness)', () => {
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
    adapter = new MockHcmAdapter({ baseUrl: harness.baseUrl, timeoutMs: 2000 }, monitor);
  });

  // ── Reads ────────────────────────────────────────────────────────────────

  describe('fetchBalance', () => {
    it('returns the parsed balance with Decimal + bigint', async () => {
      const balance = await adapter.fetchBalance({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
      });
      expect(balance.available).toBeInstanceOf(Decimal);
      expect(balance.available.toFixed()).toBe('10');
      expect(typeof balance.hcmVersion).toBe('bigint');
      expect(monitor.isHealthy()).toBe(true);
    });

    it('throws HcmEmployeeNotFoundError for an unknown employee', async () => {
      await expect(
        adapter.fetchBalance({ employeeId: 'ghost', locationId: 'loc-1', leaveTypeId: 'pto' }),
      ).rejects.toBeInstanceOf(HcmEmployeeNotFoundError);
    });

    it('throws HcmPermanentError(INVALID_DIMENSION) for an unknown dimension', async () => {
      try {
        await adapter.fetchBalance({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveTypeId: 'sick',
        });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HcmPermanentError);
        expect((err as HcmPermanentError).reason).toBe('INVALID_DIMENSION');
      }
    });
  });

  describe('fetchEmployment', () => {
    it('returns the parsed periods', async () => {
      const response = await adapter.fetchEmployment('emp-1');
      expect(response.employeeId).toBe('emp-1');
      expect(response.periods).toHaveLength(1);
      expect(response.periods[0]?.hcmVersion).toEqual(expect.any(BigInt));
    });

    it('throws HcmEmployeeNotFoundError when the employee is unknown', async () => {
      await expect(adapter.fetchEmployment('ghost')).rejects.toBeInstanceOf(
        HcmEmployeeNotFoundError,
      );
    });
  });

  describe('fetchLeaveTypes', () => {
    it('returns the list for a location', async () => {
      const response = await adapter.fetchLeaveTypes('loc-1');
      expect(response.leaveTypes).toHaveLength(1);
      expect(response.leaveTypes[0]?.isActive).toBe(true);
    });

    it('returns an empty list when nothing is configured for the location', async () => {
      const response = await adapter.fetchLeaveTypes('loc-empty');
      expect(response.leaveTypes).toEqual([]);
    });
  });

  describe('fetchEmployee', () => {
    it('returns the employee record', async () => {
      const response = await adapter.fetchEmployee('emp-1');
      expect(response.employeeId).toBe('emp-1');
    });

    it('throws HcmEmployeeNotFoundError carrying the requested employeeId', async () => {
      try {
        await adapter.fetchEmployee('emp-gone');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HcmEmployeeNotFoundError);
        expect((err as HcmEmployeeNotFoundError).employeeId).toBe('emp-gone');
      }
    });
  });

  // ── Mutations ────────────────────────────────────────────────────────────

  describe('reserveBalance', () => {
    it('applies the debit and returns the mutation confirmation', async () => {
      const res = await adapter.reserveBalance(
        { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: new Decimal('3') },
        'idem-1',
      );
      expect(res.deltaApplied.toFixed()).toBe('-3');
      expect(res.newAvailable.toFixed()).toBe('7');
      expect(typeof res.hcmVersion).toBe('bigint');
    });

    it('throws HcmPermanentError(INSUFFICIENT_BALANCE) when HCM rejects', async () => {
      try {
        await adapter.reserveBalance(
          { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: new Decimal('999') },
          'idem-too-much',
        );
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HcmPermanentError);
        expect((err as HcmPermanentError).reason).toBe('INSUFFICIENT_BALANCE');
      }
    });

    it('returns the prior result on idempotent retry', async () => {
      const first = await adapter.reserveBalance(
        { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: new Decimal('2') },
        'idem-replay',
      );
      const second = await adapter.reserveBalance(
        { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: new Decimal('2') },
        'idem-replay',
      );
      expect(second.transactionId).toBe(first.transactionId);
      await harness.assertBalance('emp-1', 'loc-1', 'pto', { available: '8' });
    });

    it('throws HcmEmployeeNotFoundError when HCM has no record of the employee (Q.ν)', async () => {
      await harness.deleteEmployee('emp-1');
      try {
        await adapter.reserveBalance(
          { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: new Decimal('1') },
          'idem-after-delete',
        );
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HcmEmployeeNotFoundError);
        expect((err as HcmEmployeeNotFoundError).employeeId).toBe('emp-1');
      }
    });
  });

  describe('releaseBalance', () => {
    it('credits the balance', async () => {
      const res = await adapter.releaseBalance(
        { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: new Decimal('4') },
        'idem-release',
      );
      expect(res.deltaApplied.toFixed()).toBe('4');
      expect(res.newAvailable.toFixed()).toBe('14');
    });
  });

  // ── queryTransactions (TRD §13.2.1) ───────────────────────────────────────

  describe('queryTransactions', () => {
    beforeEach(async () => {
      await adapter.reserveBalance(
        { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: new Decimal('2') },
        'action-a',
      );
      await adapter.reserveBalance(
        { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: new Decimal('1') },
        'action-b',
      );
    });

    it('returns all matching ACCEPTED transactions', async () => {
      const records = await adapter.queryTransactions({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
      });
      expect(records).toHaveLength(2);
      expect(records[0]?.deltaApplied.toFixed()).toBe('-2');
    });

    it('returns at most one record when filtered by idempotency key', async () => {
      const records = await adapter.queryTransactions({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        idempotencyKey: 'action-b',
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.idempotencyKey).toBe('action-b');
    });

    it('returns empty when nothing matches', async () => {
      const records = await adapter.queryTransactions({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        idempotencyKey: 'never-applied',
      });
      expect(records).toEqual([]);
    });

    it('throws HcmEmployeeNotFoundError when the queried employee was deleted (Q.ν)', async () => {
      await harness.deleteEmployee('emp-1');
      await expect(
        adapter.queryTransactions({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveTypeId: 'pto',
          idempotencyKey: 'action-a',
        }),
      ).rejects.toBeInstanceOf(HcmEmployeeNotFoundError);
    });
  });

  // ── Batch (NDJSON stream) ────────────────────────────────────────────────

  describe('fetchBatch', () => {
    it('yields every seeded balance row', async () => {
      await harness.seedBalance({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'sick',
        available: '5',
      });
      const collected = [];
      for await (const entry of adapter.fetchBatch()) collected.push(entry);
      expect(collected).toHaveLength(2);
      expect(collected.map((c) => c.leaveTypeId).sort()).toEqual(['pto', 'sick']);
    });

    it('yields nothing when no balances exist', async () => {
      await harness.reset();
      const collected = [];
      for await (const entry of adapter.fetchBatch()) collected.push(entry);
      expect(collected).toEqual([]);
    });
  });

  // ── Transport / health monitor integration ───────────────────────────────

  describe('transport failures', () => {
    it('translates network errors into HcmTransientError and records failure', async () => {
      const offline = new MockHcmAdapter(
        { baseUrl: 'http://127.0.0.1:1', timeoutMs: 250 },
        monitor,
      );
      await expect(offline.fetchEmployee('emp-1')).rejects.toBeInstanceOf(HcmTransientError);
      await expect(offline.fetchEmployee('emp-1')).rejects.toBeInstanceOf(HcmTransientError);
      expect(monitor.isHealthy()).toBe(false);
      expect(monitor.outageStartedAt()).not.toBeNull();
    });

    it('does NOT flip the monitor on 4xx — HCM is reachable, the request was just wrong', async () => {
      await adapter.fetchBalance({ employeeId: 'ghost', locationId: 'loc-1', leaveTypeId: 'pto' }).catch(
        () => undefined,
      );
      await adapter
        .fetchBalance({ employeeId: 'ghost', locationId: 'loc-1', leaveTypeId: 'pto' })
        .catch(() => undefined);
      expect(monitor.isHealthy()).toBe(true);
    });

    it('exposes HcmContractViolation as a distinct error class for downstream routing', () => {
      // Smoke check on the imported symbol. Adversarial modes that exercise
      // contract violations end-to-end (TRD §17.3) are not yet implemented
      // in the mock.
      expect(HcmContractViolation).toBeDefined();
    });

    it('labels socket failures as `network failure` (not timeout)', async () => {
      const offline = new MockHcmAdapter(
        { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 },
        new HcmHealthMonitor({ unhealthyAfterFailures: 100 }),
      );
      await expect(offline.fetchEmployee('emp-1')).rejects.toBeInstanceOf(HcmTransientError);
      await expect(offline.fetchEmployee('emp-1')).rejects.toThrow(/network failure/);
      await expect(offline.fetchEmployee('emp-1')).rejects.not.toThrow(/timeout/);
    });

    it('strips a trailing slash from baseUrl so paths join cleanly', async () => {
      // Both adapters should hit the same URL whether or not the operator
      // included a trailing slash in their config.
      const withSlash = new MockHcmAdapter(
        { baseUrl: `${harness.baseUrl}/`, timeoutMs: 5_000 },
        new HcmHealthMonitor({ unhealthyAfterFailures: 100 }),
      );
      const result = await withSlash.fetchEmployee('emp-1');
      expect(result.employeeId).toBe('emp-1');
    });
  });
});
