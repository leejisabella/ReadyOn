import {
  ERROR_CODES,
  ERROR_CODE_METADATA,
  isErrorCode,
  type ErrorCode,
  type Retryable,
} from './error-code';

describe('ErrorCode taxonomy (TRD §14.6)', () => {
  it('declares every code listed in TRD §14.6 (25 codes through Rev 3.1)', () => {
    expect(ERROR_CODES).toHaveLength(25);
  });

  it('contains the Rev 3 break-glass codes', () => {
    expect(ERROR_CODES).toContain('BREAK_GLASS_NOT_AUTHORIZED');
    expect(ERROR_CODES).toContain('BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET');
    expect(ERROR_CODES).toContain('CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT');
    expect(ERROR_CODES).toContain('HR_REVIEW_REQUIRED');
  });

  it('contains the Rev 3.1 employee-deletion code (Q.ν)', () => {
    expect(ERROR_CODES).toContain('EMPLOYEE_NOT_FOUND_AT_HCM_DURING_RECONCILIATION');
  });

  it('has unique codes (no duplicates)', () => {
    const set = new Set(ERROR_CODES);
    expect(set.size).toBe(ERROR_CODES.length);
  });

  it('exposes metadata for every code with no missing keys', () => {
    for (const code of ERROR_CODES) {
      const meta = ERROR_CODE_METADATA[code];
      expect(meta).toBeDefined();
      expect(typeof meta.defaultMessage).toBe('string');
      expect(meta.defaultMessage.length).toBeGreaterThan(0);
      expect(meta.surfaces.length).toBeGreaterThan(0);
      expect(['yes', 'no', 'na']).toContain(meta.retryable satisfies Retryable);
    }
  });

  it('has no extra keys in the metadata table beyond declared codes', () => {
    const declared = new Set<string>(ERROR_CODES);
    for (const k of Object.keys(ERROR_CODE_METADATA)) {
      expect(declared.has(k)).toBe(true);
    }
  });

  it.each([
    ['HCM_UNAVAILABLE', 'yes'],
    ['BALANCE_UNDER_RECONCILIATION', 'yes'],
    ['PROVISIONAL_RECONCILIATION_TRANSIENT_FAILURE', 'yes'],
    ['HCM_RESPONSE_INVALID', 'yes'],
    ['INVALID_DATES', 'no'],
    ['STATE_TRANSITION_NOT_ALLOWED', 'no'],
    ['BREAK_GLASS_NOT_AUTHORIZED', 'no'],
    ['CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT', 'no'],
    ['HR_REVIEW_REQUIRED', 'na'],
    ['PROVISIONAL_RECONCILIATION_REJECTED', 'na'],
    ['EMPLOYEE_NOT_FOUND_AT_HCM_DURING_RECONCILIATION', 'na'],
  ] as ReadonlyArray<readonly [ErrorCode, Retryable]>)(
    'matches TRD §14.6 retryable classification for %s',
    (code, expected) => {
      expect(ERROR_CODE_METADATA[code].retryable).toBe(expected);
    },
  );

  it.each([
    ['BREAK_GLASS_NOT_AUTHORIZED', 'approveProvisionally'],
    ['BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET', 'approveProvisionally'],
    ['CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT', 'cancel'],
    ['TERMINAL_STATE_REACHED', 'cancel'],
    ['EMPLOYMENT_NOT_FOUND', 'create'],
    ['EMPLOYEE_NOT_BOOTSTRAPPED', 'create'],
    ['HR_REVIEW_REQUIRED', 'read'],
    ['HCM_RESPONSE_INVALID', 'internal'],
  ] as const)('surfaces %s on %s', (code, surface) => {
    expect(ERROR_CODE_METADATA[code as ErrorCode].surfaces).toContain(surface);
  });

  it('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT surfaces on every client mutation', () => {
    const surfaces = ERROR_CODE_METADATA.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT.surfaces;
    expect(surfaces).toEqual(
      expect.arrayContaining(['create', 'approve', 'approveProvisionally', 'reject', 'cancel']),
    );
  });

  it('metadata is deeply immutable (Object.freeze defends against accidental mutation)', () => {
    expect(Object.isFrozen(ERROR_CODE_METADATA)).toBe(true);
  });
});

describe('isErrorCode (type guard)', () => {
  it('returns true for declared codes', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('returns false for non-codes', () => {
    expect(isErrorCode('NOT_A_CODE')).toBe(false);
    expect(isErrorCode('')).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode({})).toBe(false);
  });
});
