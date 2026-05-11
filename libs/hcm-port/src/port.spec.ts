import Decimal from 'decimal.js';
import type { HcmPort } from './port';
import type { HcmBatchEntry } from './schemas';

/**
 * Compile-time contract test: this literal MUST be assignable to
 * {@link HcmPort}. If the interface evolves incompatibly, the annotation
 * below fails to type-check and CI fails.
 *
 * The bodies are deliberately minimal — this is a shape check, not a
 * behaviour check. Behaviour is exercised by adapter tests in later slices.
 */
const stub: HcmPort = {
  async fetchBalance() {
    return {
      employeeId: 'emp',
      locationId: 'loc',
      leaveTypeId: 'pto',
      available: new Decimal('10'),
      hcmVersion: 1n,
      appliedAt: '2026-05-11T00:00:00Z',
    };
  },

  async reserveBalance() {
    return {
      transactionId: 'txn',
      deltaApplied: new Decimal('-1'),
      newAvailable: new Decimal('9'),
      hcmVersion: 2n,
      appliedAt: '2026-05-11T00:00:00Z',
    };
  },

  async releaseBalance() {
    return {
      transactionId: 'txn',
      deltaApplied: new Decimal('1'),
      newAvailable: new Decimal('10'),
      hcmVersion: 3n,
      appliedAt: '2026-05-11T00:00:00Z',
    };
  },

  async fetchEmployment() {
    return { employeeId: 'emp', periods: [] };
  },

  async fetchLeaveTypes() {
    return { locationId: 'loc', leaveTypes: [] };
  },

  async fetchEmployee() {
    return { employeeId: 'emp', hcmVersion: 1n, employment: [] };
  },

  fetchBatch() {
    return (async function* () {
      // empty stream
    })();
  },

  async queryTransactions() {
    return [];
  },
};

describe('HcmPort (shape contract)', () => {
  it('admits a stub implementation with all eight methods', () => {
    expect(typeof stub.fetchBalance).toBe('function');
    expect(typeof stub.reserveBalance).toBe('function');
    expect(typeof stub.releaseBalance).toBe('function');
    expect(typeof stub.fetchEmployment).toBe('function');
    expect(typeof stub.fetchLeaveTypes).toBe('function');
    expect(typeof stub.fetchEmployee).toBe('function');
    expect(typeof stub.fetchBatch).toBe('function');
    expect(typeof stub.queryTransactions).toBe('function');
  });

  it('fetchBatch returns an AsyncIterable that drains to a list', async () => {
    const collected: HcmBatchEntry[] = [];
    for await (const entry of stub.fetchBatch()) {
      collected.push(entry);
    }
    expect(collected).toEqual([]);
  });

  it('mutation responses carry the five contract fields (ADR-005)', async () => {
    const res = await stub.reserveBalance(
      { employeeId: 'emp', locationId: 'loc', leaveTypeId: 'pto', units: new Decimal('1') },
      'idem-key',
    );
    expect(res).toMatchObject({
      transactionId: expect.any(String),
      deltaApplied: expect.any(Decimal),
      newAvailable: expect.any(Decimal),
      hcmVersion: expect.any(BigInt),
      appliedAt: expect.any(String),
    });
  });
});
