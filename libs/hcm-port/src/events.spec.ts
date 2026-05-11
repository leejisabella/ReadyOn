import {
  BalanceUpdatedEventSchema,
  EmployeeCreatedEventSchema,
  EmploymentChangedEventSchema,
  HCM_WEBHOOK_TYPES,
  HcmWebhookEnvelopeSchema,
  LeaveTypeChangedEventSchema,
} from './events';

const baseEnvelope = {
  eventId: 'evt-1',
  hcmVersion: '7',
  appliedAt: '2026-05-11T12:00:00Z',
};

describe('Webhook event taxonomy', () => {
  it('declares exactly four event types (TRD §10.1)', () => {
    expect(HCM_WEBHOOK_TYPES).toEqual([
      'BALANCE_UPDATED',
      'EMPLOYMENT_CHANGED',
      'LEAVE_TYPE_CHANGED',
      'EMPLOYEE_CREATED',
    ]);
  });
});

describe('BalanceUpdatedEventSchema', () => {
  it('parses a valid event', () => {
    const parsed = BalanceUpdatedEventSchema.parse({
      ...baseEnvelope,
      type: 'BALANCE_UPDATED',
      payload: { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', available: '12.50' },
    });
    expect(parsed.type).toBe('BALANCE_UPDATED');
    expect(parsed.hcmVersion).toBe(7n);
    expect(parsed.payload.available).toBe('12.50');
  });

  it('rejects a wrong type literal', () => {
    expect(
      BalanceUpdatedEventSchema.safeParse({
        ...baseEnvelope,
        type: 'EMPLOYMENT_CHANGED',
        payload: { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', available: '1' },
      }).success,
    ).toBe(false);
  });
});

describe('EmploymentChangedEventSchema', () => {
  it('parses with optional effectiveTo absent (open-ended period)', () => {
    const parsed = EmploymentChangedEventSchema.parse({
      ...baseEnvelope,
      type: 'EMPLOYMENT_CHANGED',
      payload: { employeeId: 'emp-1', locationId: 'loc-b', effectiveFrom: '2026-06-01' },
    });
    expect(parsed.payload.effectiveTo).toBeUndefined();
  });

  it('rejects a malformed effectiveFrom date', () => {
    expect(
      EmploymentChangedEventSchema.safeParse({
        ...baseEnvelope,
        type: 'EMPLOYMENT_CHANGED',
        payload: { employeeId: 'emp-1', locationId: 'loc-b', effectiveFrom: 'June 1 2026' },
      }).success,
    ).toBe(false);
  });
});

describe('LeaveTypeChangedEventSchema', () => {
  it('parses an activation event', () => {
    const parsed = LeaveTypeChangedEventSchema.parse({
      ...baseEnvelope,
      type: 'LEAVE_TYPE_CHANGED',
      payload: {
        locationId: 'loc-a',
        leaveTypeId: 'parental',
        isActive: true,
        effectiveFrom: '2026-01-01',
      },
    });
    expect(parsed.payload.isActive).toBe(true);
  });
});

describe('EmployeeCreatedEventSchema (drives bootstrap, TRD §11.2)', () => {
  it('carries the initial employment row in the payload', () => {
    const parsed = EmployeeCreatedEventSchema.parse({
      ...baseEnvelope,
      type: 'EMPLOYEE_CREATED',
      payload: {
        employeeId: 'emp-new',
        employment: { locationId: 'loc-a', effectiveFrom: '2026-05-11' },
      },
    });
    expect(parsed.payload.employment.locationId).toBe('loc-a');
  });

  it('rejects when the employment block is missing', () => {
    expect(
      EmployeeCreatedEventSchema.safeParse({
        ...baseEnvelope,
        type: 'EMPLOYEE_CREATED',
        payload: { employeeId: 'emp-new' },
      }).success,
    ).toBe(false);
  });
});

describe('HcmWebhookEnvelopeSchema (discriminated union)', () => {
  it.each([
    [
      'BALANCE_UPDATED',
      { employeeId: 'e', locationId: 'l', leaveTypeId: 'pto', available: '5.00' },
    ],
    [
      'EMPLOYMENT_CHANGED',
      { employeeId: 'e', locationId: 'l', effectiveFrom: '2026-05-11' },
    ],
    [
      'LEAVE_TYPE_CHANGED',
      { locationId: 'l', leaveTypeId: 'pto', isActive: true, effectiveFrom: '2026-05-11' },
    ],
    [
      'EMPLOYEE_CREATED',
      { employeeId: 'e', employment: { locationId: 'l', effectiveFrom: '2026-05-11' } },
    ],
  ] as const)('routes type=%s to the matching member schema', (type, payload) => {
    const parsed = HcmWebhookEnvelopeSchema.parse({ ...baseEnvelope, type, payload });
    expect(parsed.type).toBe(type);
  });

  it('rejects an unknown type', () => {
    expect(
      HcmWebhookEnvelopeSchema.safeParse({ ...baseEnvelope, type: 'NOPE', payload: {} }).success,
    ).toBe(false);
  });

  it('rejects when discriminator is absent', () => {
    expect(HcmWebhookEnvelopeSchema.safeParse({ ...baseEnvelope, payload: {} }).success).toBe(false);
  });

  it('rejects extra envelope fields (strict mode catches contract drift)', () => {
    expect(
      HcmWebhookEnvelopeSchema.safeParse({
        ...baseEnvelope,
        type: 'BALANCE_UPDATED',
        payload: { employeeId: 'e', locationId: 'l', leaveTypeId: 'pto', available: '5.00' },
        secretField: 'oh hi',
      }).success,
    ).toBe(false);
  });
});
