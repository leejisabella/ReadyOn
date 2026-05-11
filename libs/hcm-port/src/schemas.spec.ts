import Decimal from 'decimal.js';
import {
  HcmBatchEntrySchema,
  HcmEmployeeResponseSchema,
  HcmEmploymentResponseSchema,
  HcmFetchBalanceResponseSchema,
  HcmLeaveTypesResponseSchema,
  HcmMutationResponseSchema,
  HcmTransactionHistorySchema,
  HcmTransactionRecordSchema,
} from './schemas';

const validMutation = {
  transactionId: 'txn-abc',
  deltaApplied: '-2.00',
  newAvailable: '8.00',
  hcmVersion: '17',
  appliedAt: '2026-05-11T14:23:45.123Z',
};

describe('HcmMutationResponseSchema (TRD §13.2, ADR-005)', () => {
  it('parses a complete response and transforms strings into Decimal/bigint', () => {
    const parsed = HcmMutationResponseSchema.parse(validMutation);
    expect(parsed.transactionId).toBe('txn-abc');
    expect(parsed.deltaApplied).toBeInstanceOf(Decimal);
    expect(parsed.deltaApplied.toFixed()).toBe('-2');
    expect(parsed.newAvailable.toFixed()).toBe('8');
    expect(parsed.hcmVersion).toBe(17n);
    expect(parsed.appliedAt).toBe('2026-05-11T14:23:45.123Z');
  });

  it.each(['transactionId', 'deltaApplied', 'newAvailable', 'hcmVersion', 'appliedAt'] as const)(
    'rejects when required field %s is missing',
    (missing) => {
      const partial: Record<string, unknown> = { ...validMutation };
      delete partial[missing];
      expect(HcmMutationResponseSchema.safeParse(partial).success).toBe(false);
    },
  );

  it('rejects extra fields (strict mode catches contract drift)', () => {
    const extra = { ...validMutation, somethingNew: 'oh no' };
    expect(HcmMutationResponseSchema.safeParse(extra).success).toBe(false);
  });

  it('rejects empty transactionId', () => {
    expect(HcmMutationResponseSchema.safeParse({ ...validMutation, transactionId: '' }).success).toBe(false);
  });

  it('rejects decimal supplied as JSON number (must be a string at the wire)', () => {
    expect(
      HcmMutationResponseSchema.safeParse({ ...validMutation, deltaApplied: -2 as unknown as string }).success,
    ).toBe(false);
  });

  it('rejects malformed decimal string', () => {
    expect(HcmMutationResponseSchema.safeParse({ ...validMutation, newAvailable: '1e3' }).success).toBe(false);
  });

  it('rejects hcmVersion that is not a base-10 integer string', () => {
    expect(HcmMutationResponseSchema.safeParse({ ...validMutation, hcmVersion: '17.5' }).success).toBe(false);
    expect(HcmMutationResponseSchema.safeParse({ ...validMutation, hcmVersion: '0x10' }).success).toBe(false);
    expect(HcmMutationResponseSchema.safeParse({ ...validMutation, hcmVersion: 17 as unknown as string }).success).toBe(false);
  });

  it('rejects appliedAt without explicit timezone (per TRD §10.1)', () => {
    expect(
      HcmMutationResponseSchema.safeParse({ ...validMutation, appliedAt: '2026-05-11T14:23:45.123' }).success,
    ).toBe(false);
  });
});

describe('HcmFetchBalanceResponseSchema', () => {
  it('parses a balance read with decimal and bigint coercion', () => {
    const parsed = HcmFetchBalanceResponseSchema.parse({
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      available: '12.50',
      hcmVersion: '42',
      appliedAt: '2026-05-11T00:00:00Z',
    });
    expect(parsed.available.toFixed()).toBe('12.5');
    expect(parsed.hcmVersion).toBe(42n);
  });
});

describe('HcmEmploymentResponseSchema', () => {
  it('parses an employment timeline with current + historical periods', () => {
    const parsed = HcmEmploymentResponseSchema.parse({
      employeeId: 'emp-1',
      periods: [
        { locationId: 'loc-a', effectiveFrom: '2024-01-01', effectiveTo: '2025-06-30', hcmVersion: '1' },
        { locationId: 'loc-b', effectiveFrom: '2025-07-01', hcmVersion: '2' },
      ],
    });
    expect(parsed.periods).toHaveLength(2);
    expect(parsed.periods[0]?.hcmVersion).toBe(1n);
    expect(parsed.periods[1]?.effectiveTo).toBeUndefined();
  });

  it('accepts effectiveTo: null (HCM sends null for active periods)', () => {
    const parsed = HcmEmploymentResponseSchema.parse({
      employeeId: 'emp-1',
      periods: [{ locationId: 'loc-a', effectiveFrom: '2024-01-01', effectiveTo: null, hcmVersion: '1' }],
    });
    expect(parsed.periods[0]?.effectiveTo).toBeNull();
  });

  it('rejects malformed dates', () => {
    const bad = {
      employeeId: 'emp-1',
      periods: [{ locationId: 'loc-a', effectiveFrom: '01/01/2024', hcmVersion: '1' }],
    };
    expect(HcmEmploymentResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('HcmLeaveTypesResponseSchema', () => {
  it('parses an array of leave-type entries', () => {
    const parsed = HcmLeaveTypesResponseSchema.parse({
      locationId: 'loc-a',
      leaveTypes: [
        { leaveTypeId: 'pto', isActive: true, effectiveFrom: '2024-01-01', hcmVersion: '1' },
        { leaveTypeId: 'sick', isActive: false, effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31', hcmVersion: '5' },
      ],
    });
    expect(parsed.leaveTypes).toHaveLength(2);
    expect(parsed.leaveTypes[1]?.isActive).toBe(false);
  });
});

describe('HcmEmployeeResponseSchema (lazy bootstrap, TRD §11.3)', () => {
  it('parses an employee with their employment history', () => {
    const parsed = HcmEmployeeResponseSchema.parse({
      employeeId: 'emp-1',
      hcmVersion: '7',
      employment: [{ locationId: 'loc-a', effectiveFrom: '2025-01-01', hcmVersion: '7' }],
    });
    expect(parsed.employeeId).toBe('emp-1');
    expect(parsed.employment).toHaveLength(1);
  });
});

describe('HcmTransactionRecordSchema (Rev 3, TRD §13.2.1)', () => {
  it('parses a transaction with idempotencyKey set', () => {
    const parsed = HcmTransactionRecordSchema.parse({
      transactionId: 'txn-1',
      idempotencyKey: 'action-uuid-1',
      deltaApplied: '-2.00',
      appliedAt: '2026-05-11T10:00:00Z',
      hcmVersion: '99',
    });
    expect(parsed.idempotencyKey).toBe('action-uuid-1');
    expect(parsed.deltaApplied.toFixed()).toBe('-2');
  });

  it('parses a transaction with no idempotencyKey (external systems write to HCM too)', () => {
    const parsed = HcmTransactionRecordSchema.parse({
      transactionId: 'txn-2',
      deltaApplied: '5.00',
      appliedAt: '2026-05-11T10:00:00Z',
      hcmVersion: '100',
    });
    expect(parsed.idempotencyKey).toBeUndefined();
  });

  it('rejects empty idempotencyKey when present', () => {
    const bad = {
      transactionId: 'txn-3',
      idempotencyKey: '',
      deltaApplied: '1.00',
      appliedAt: '2026-05-11T10:00:00Z',
      hcmVersion: '1',
    };
    expect(HcmTransactionRecordSchema.safeParse(bad).success).toBe(false);
  });
});

describe('HcmTransactionHistorySchema', () => {
  it('accepts an empty list (no transactions match the filter)', () => {
    expect(HcmTransactionHistorySchema.parse([])).toEqual([]);
  });

  it('parses a list of records preserving order', () => {
    const records = [
      { transactionId: 'a', deltaApplied: '-1.00', appliedAt: '2026-05-11T00:00:00Z', hcmVersion: '1' },
      { transactionId: 'b', deltaApplied: '-2.00', appliedAt: '2026-05-11T01:00:00Z', hcmVersion: '2' },
    ];
    const parsed = HcmTransactionHistorySchema.parse(records);
    expect(parsed.map((r) => r.transactionId)).toEqual(['a', 'b']);
  });
});

describe('HcmBatchEntrySchema', () => {
  it('parses a single batch row', () => {
    const parsed = HcmBatchEntrySchema.parse({
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      available: '20.00',
      hcmVersion: '3',
      appliedAt: '2026-05-11T00:00:00Z',
    });
    expect(parsed.available.toFixed()).toBe('20');
  });
});
