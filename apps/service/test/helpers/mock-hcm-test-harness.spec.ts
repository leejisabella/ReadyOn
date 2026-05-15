import Decimal from 'decimal.js';
import {
  MockHcmHarnessAssertionError,
  MockHcmTestHarness,
} from './mock-hcm-test-harness';

/**
 * Layer 24 — MockHcmTestHarness self-tests (TRD §17.6, ADR-020).
 *
 * Every higher-layer test in the suite leans on the harness, so a regression
 * here would silently invalidate everything above. Each public method has at
 * least one passing case; assertion failures are caught and inspected to
 * confirm the error type and context.
 */
describe('MockHcmTestHarness (Layer 24)', () => {
  let harness: MockHcmTestHarness;

  beforeAll(async () => {
    harness = await MockHcmTestHarness.boot();
  });

  afterAll(async () => {
    await harness.shutdown();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  // ── Boot / shutdown (T-HRN-10) ───────────────────────────────────────────

  describe('boot + shutdown', () => {
    it('exposes a usable baseUrl', () => {
      expect(harness.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('boots a separate instance with its own state', async () => {
      const other = await MockHcmTestHarness.boot();
      try {
        expect(other.baseUrl).not.toBe(harness.baseUrl);
        await other.seedEmployee({ employeeId: 'emp-isolated' });
        const otherSnap = await other.snapshot();
        const ourSnap = await harness.snapshot();
        expect(otherSnap.employees.map((e) => e.employeeId)).toContain('emp-isolated');
        expect(ourSnap.employees.map((e) => e.employeeId)).not.toContain('emp-isolated');
      } finally {
        await other.shutdown();
      }
    });
  });

  // ── reset (T-HRN-01) ────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears every store', async () => {
      await harness.seedEmployee({
        employeeId: 'emp-1',
        balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '10' }],
      });
      await harness.reset();
      const snap = await harness.snapshot();
      expect(snap.employees).toEqual([]);
      expect(snap.balances).toEqual([]);
      expect(snap.currentHcmVersion).toBe('0');
    });
  });

  // ── snapshot + restoreSnapshot (T-HRN-05) ───────────────────────────────

  describe('snapshot / restoreSnapshot', () => {
    it('restores state to match the captured snapshot', async () => {
      await harness.seedEmployee({
        employeeId: 'emp-snap',
        employment: [{ locationId: 'loc-1', effectiveFrom: '2025-01-01' }],
        balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '5.5' }],
      });
      await harness.seedLeaveTypeAvailability({
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        isActive: true,
        effectiveFrom: '2025-01-01',
      });
      const original = await harness.snapshot();

      // mutate
      await harness.seedBalance({
        employeeId: 'emp-snap',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        available: '999',
      });
      const mutated = await harness.snapshot();
      expect(mutated.balances[0]!.available).toBe('999');

      // restore
      await harness.restoreSnapshot(original);
      const restored = await harness.snapshot();
      expect(restored.balances).toEqual(original.balances);
      expect(restored.employees).toEqual(original.employees);
      expect(restored.employment).toEqual(original.employment);
      expect(restored.currentHcmVersion).toBe(original.currentHcmVersion);
    });
  });

  // ── seeding (T-HRN-02) ───────────────────────────────────────────────────

  describe('seedEmployee', () => {
    it('creates the employee with optional employment and balances', async () => {
      await harness.seedEmployee({
        employeeId: 'emp-2',
        employment: [{ locationId: 'loc-a', effectiveFrom: '2025-01-01' }],
        balances: [
          { locationId: 'loc-a', leaveTypeId: 'pto', available: new Decimal('20') },
          { locationId: 'loc-a', leaveTypeId: 'sick', available: '5' },
        ],
      });
      const snap = await harness.snapshot();
      expect(snap.employees.map((e) => e.employeeId)).toEqual(['emp-2']);
      expect(snap.employment.map((p) => p.locationId)).toEqual(['loc-a']);
      expect(snap.balances).toHaveLength(2);
    });

    it('is idempotent — re-seeding the same employee leaves a single row', async () => {
      await harness.seedEmployee({ employeeId: 'emp-dup' });
      await harness.seedEmployee({ employeeId: 'emp-dup' });
      const snap = await harness.snapshot();
      expect(snap.employees.filter((e) => e.employeeId === 'emp-dup')).toHaveLength(1);
    });
  });

  describe('seedBalance', () => {
    it('accepts Decimal and string representations interchangeably', async () => {
      await harness.seedEmployee({ employeeId: 'emp-3' });
      await harness.seedBalance({
        employeeId: 'emp-3',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        available: new Decimal('7.50'),
      });
      await harness.assertBalance('emp-3', 'loc-1', 'pto', { available: '7.5' });
    });
  });

  describe('seedTransaction', () => {
    it('plants a synthetic transaction visible via listTransactions', async () => {
      await harness.seedEmployee({ employeeId: 'emp-4' });
      await harness.seedTransaction({
        transactionId: 'planted-txn-1',
        idempotencyKey: 'action-planted',
        employeeId: 'emp-4',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        deltaApplied: '-2',
        newAvailable: '8',
        hcmVersion: 999n,
        appliedAt: '2026-04-01T00:00:00.000Z',
      });
      const txns = await harness.listTransactions();
      expect(txns.map((t) => t.transactionId)).toEqual(['planted-txn-1']);
      expect(txns[0]!.hcmVersion).toBe('999');
    });
  });

  // ── deleteEmployee (Q.ν) ─────────────────────────────────────────────────

  describe('deleteEmployee', () => {
    it('removes an employee record', async () => {
      await harness.seedEmployee({ employeeId: 'emp-gone' });
      await harness.deleteEmployee('emp-gone');
      const snap = await harness.snapshot();
      expect(snap.employees.map((e) => e.employeeId)).not.toContain('emp-gone');
    });

    it('is a no-op when the employee never existed', async () => {
      await expect(harness.deleteEmployee('emp-never')).resolves.toBeUndefined();
    });
  });

  // ── Mode + reachability (TRD §17.3 — full coverage) ─────────────────────

  describe('mode + reachability', () => {
    afterEach(async () => {
      await harness.setMode('normal');
      await harness.setReachability('on');
    });

    it('T-HRN-03 — setMode("normal") is the harness default', async () => {
      await harness.setMode('normal');
      const state = await harness.getMode();
      expect(state.mode).toBe('normal');
    });

    it('T-HRN-03b — setMode("flaky", { flakyRate, forceNextCalls }) configures the store', async () => {
      await harness.setMode('flaky', { flakyRate: 0.75, forceNextCalls: 3 });
      const state = await harness.getMode();
      expect(state.mode).toBe('flaky');
      expect(state.flakyRate).toBe(0.75);
      expect(state.forceNextCalls).toBe(3);
    });

    it('T-HRN-03c — every adversarial mode is accepted', async () => {
      const modes = [
        'silent_no_op',
        'wrong_delta',
        'missing_confirmation',
        'stale_version',
        'malformed',
        'slow',
        'version_skew',
      ] as const;
      for (const m of modes) {
        await harness.setMode(m);
        expect((await harness.getMode()).mode).toBe(m);
      }
    });

    it('T-HRN-04 — setReachability("on") is the default', async () => {
      await harness.setReachability('on');
      expect((await harness.getMode()).reachability).toBe('on');
    });

    it('T-HRN-04b — setReachability("off") flips the gate', async () => {
      await harness.setReachability('off');
      expect((await harness.getMode()).reachability).toBe('off');
    });

    it('T-HRN-04c — reset() restores defaults (normal + on)', async () => {
      await harness.setMode('flaky', { flakyRate: 1 });
      await harness.setReachability('off');
      await harness.reset();
      const state = await harness.getMode();
      expect(state.mode).toBe('normal');
      expect(state.reachability).toBe('on');
    });
  });

  // ── Assertions (T-HRN-06, T-HRN-07) ─────────────────────────────────────

  describe('assertBalance', () => {
    beforeEach(async () => {
      await harness.seedEmployee({
        employeeId: 'emp-a',
        balances: [{ locationId: 'loc-1', leaveTypeId: 'pto', available: '10' }],
      });
    });

    it('passes when the balance matches', async () => {
      await expect(
        harness.assertBalance('emp-a', 'loc-1', 'pto', { available: '10' }),
      ).resolves.toBeUndefined();
    });

    it('treats Decimal "10" and "10.00" as equal', async () => {
      await expect(
        harness.assertBalance('emp-a', 'loc-1', 'pto', { available: '10.00' }),
      ).resolves.toBeUndefined();
      await expect(
        harness.assertBalance('emp-a', 'loc-1', 'pto', { available: new Decimal('10') }),
      ).resolves.toBeUndefined();
    });

    it('throws MockHcmHarnessAssertionError on mismatched available', async () => {
      await expect(
        harness.assertBalance('emp-a', 'loc-1', 'pto', { available: '11' }),
      ).rejects.toBeInstanceOf(MockHcmHarnessAssertionError);
    });

    it('throws when the balance does not exist', async () => {
      try {
        await harness.assertBalance('emp-a', 'loc-1', 'sick', { available: '0' });
        fail('expected assertion error');
      } catch (err) {
        expect(err).toBeInstanceOf(MockHcmHarnessAssertionError);
        expect((err as MockHcmHarnessAssertionError).context).toMatchObject({
          employeeId: 'emp-a',
          leaveTypeId: 'sick',
        });
      }
    });

    it('checks hcmVersion when supplied', async () => {
      const snap = await harness.snapshot();
      const recordedVersion = snap.balances[0]!.hcmVersion;
      await expect(
        harness.assertBalance('emp-a', 'loc-1', 'pto', { available: '10', hcmVersion: recordedVersion }),
      ).resolves.toBeUndefined();
      await expect(
        harness.assertBalance('emp-a', 'loc-1', 'pto', { available: '10', hcmVersion: '999' }),
      ).rejects.toBeInstanceOf(MockHcmHarnessAssertionError);
    });
  });

  describe('assertTransactionExists / assertTransactionDoesNotExist', () => {
    beforeEach(async () => {
      await harness.seedEmployee({ employeeId: 'emp-b' });
      await harness.seedTransaction({
        transactionId: 'txn-x',
        idempotencyKey: 'action-x',
        employeeId: 'emp-b',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        deltaApplied: '-2',
        newAvailable: '8',
        hcmVersion: 1n,
        appliedAt: '2026-05-11T00:00:00.000Z',
      });
    });

    it('exists assertion passes for a recorded transaction', async () => {
      await expect(harness.assertTransactionExists('action-x')).resolves.toBeUndefined();
    });

    it('verifies delta when supplied', async () => {
      await expect(
        harness.assertTransactionExists('action-x', { delta: '-2' }),
      ).resolves.toBeUndefined();
      await expect(
        harness.assertTransactionExists('action-x', { delta: '-3' }),
      ).rejects.toBeInstanceOf(MockHcmHarnessAssertionError);
    });

    it('verifies outcome when supplied', async () => {
      await expect(
        harness.assertTransactionExists('action-x', { outcome: 'ACCEPTED' }),
      ).resolves.toBeUndefined();
      await expect(
        harness.assertTransactionExists('action-x', { outcome: 'REJECTED' }),
      ).rejects.toBeInstanceOf(MockHcmHarnessAssertionError);
    });

    it('exists assertion fails when no transaction matches', async () => {
      await expect(
        harness.assertTransactionExists('action-missing'),
      ).rejects.toBeInstanceOf(MockHcmHarnessAssertionError);
    });

    it('doesNotExist assertion passes when there is no match', async () => {
      await expect(
        harness.assertTransactionDoesNotExist('action-missing'),
      ).resolves.toBeUndefined();
    });

    it('doesNotExist fails when a transaction matches', async () => {
      await expect(
        harness.assertTransactionDoesNotExist('action-x'),
      ).rejects.toBeInstanceOf(MockHcmHarnessAssertionError);
    });
  });

  // ── listTransactions / getState (T-HRN-aliases) ────────────────────────

  describe('listTransactions + getState', () => {
    it('listTransactions returns everything currently recorded', async () => {
      await harness.seedEmployee({ employeeId: 'emp-l' });
      await harness.seedTransaction({
        transactionId: 'a',
        idempotencyKey: 'k-a',
        employeeId: 'emp-l',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        deltaApplied: '-1',
        newAvailable: '9',
        hcmVersion: 1n,
        appliedAt: '2026-05-11T00:00:00Z',
      });
      const txns = await harness.listTransactions();
      expect(txns).toHaveLength(1);
    });

    it('getState is an alias for snapshot', async () => {
      const a = await harness.getState();
      const b = await harness.snapshot();
      expect(a).toEqual(b);
    });
  });
});
