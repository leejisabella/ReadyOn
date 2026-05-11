import { DomainError, isDomainError } from './domain-error';
import { ERROR_CODE_METADATA } from './error-code';

describe('DomainError', () => {
  it('inherits from Error and is instanceof DomainError', () => {
    const err = new DomainError({ code: 'INVALID_DATES' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.name).toBe('DomainError');
  });

  it('uses the default message from metadata when not given one', () => {
    const err = new DomainError({ code: 'HCM_UNAVAILABLE' });
    expect(err.message).toBe(ERROR_CODE_METADATA.HCM_UNAVAILABLE.defaultMessage);
  });

  it('uses the explicit message when provided', () => {
    const err = new DomainError({ code: 'HCM_UNAVAILABLE', message: 'HCM offline since 14:02 UTC' });
    expect(err.message).toBe('HCM offline since 14:02 UTC');
  });

  it('derives retryable from metadata; callers cannot override it', () => {
    expect(new DomainError({ code: 'HCM_UNAVAILABLE' }).retryable).toBe('yes');
    expect(new DomainError({ code: 'INVALID_DATES' }).retryable).toBe('no');
    expect(new DomainError({ code: 'HR_REVIEW_REQUIRED' }).retryable).toBe('na');
  });

  it('throws on unknown error codes', () => {
    expect(
      // @ts-expect-error — intentionally bypass the literal type to test the guard
      () => new DomainError({ code: 'NOT_A_REAL_CODE' }),
    ).toThrow(/unknown code/);
  });

  it('preserves correlationId, field, and details', () => {
    const err = new DomainError({
      code: 'STATE_TRANSITION_NOT_ALLOWED',
      field: 'state',
      correlationId: 'req-abc',
      details: { from: 'APPROVED', to: 'PENDING_APPROVAL' },
    });
    expect(err.field).toBe('state');
    expect(err.correlationId).toBe('req-abc');
    expect(err.details).toEqual({ from: 'APPROVED', to: 'PENDING_APPROVAL' });
  });

  it('freezes details to defend against post-construction mutation', () => {
    const err = new DomainError({
      code: 'POLICY_VIOLATION',
      details: { units: '2.50' },
    });
    expect(Object.isFrozen(err.details)).toBe(true);
  });

  it('preserves cause chain when supplied (ES2022 Error cause)', () => {
    const root = new Error('underlying I/O failure');
    const err = new DomainError({ code: 'HCM_RESPONSE_INVALID', cause: root });
    expect(err.cause).toBe(root);
  });

  it('toJSON omits undefined optional fields', () => {
    const err = new DomainError({ code: 'INVALID_DATES' });
    const json = err.toJSON();
    expect(json).toEqual({
      code: 'INVALID_DATES',
      message: ERROR_CODE_METADATA.INVALID_DATES.defaultMessage,
      retryable: 'no',
    });
    expect('field' in json).toBe(false);
    expect('correlationId' in json).toBe(false);
    expect('details' in json).toBe(false);
  });

  it('toJSON includes all populated fields', () => {
    const err = new DomainError({
      code: 'BREAK_GLASS_NOT_AUTHORIZED',
      message: 'caller is not in break_glass_approver group',
      field: 'approverId',
      correlationId: 'corr-1',
      details: { actorRole: 'manager' },
    });
    expect(err.toJSON()).toEqual({
      code: 'BREAK_GLASS_NOT_AUTHORIZED',
      message: 'caller is not in break_glass_approver group',
      retryable: 'no',
      field: 'approverId',
      correlationId: 'corr-1',
      details: { actorRole: 'manager' },
    });
  });

  it('has a stack trace pointing at the throwing site', () => {
    function thrower(): never {
      throw new DomainError({ code: 'EMPLOYMENT_NOT_FOUND' });
    }
    try {
      thrower();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as Error).stack).toContain('thrower');
    }
  });
});

describe('isDomainError (type guard)', () => {
  it('returns true for DomainError instances', () => {
    expect(isDomainError(new DomainError({ code: 'INVALID_DATES' }))).toBe(true);
  });

  it('returns false for plain Errors and other values', () => {
    expect(isDomainError(new Error('plain'))).toBe(false);
    expect(isDomainError(new TypeError('typed'))).toBe(false);
    expect(isDomainError({ code: 'INVALID_DATES', message: 'fake' })).toBe(false);
    expect(isDomainError(null)).toBe(false);
    expect(isDomainError(undefined)).toBe(false);
    expect(isDomainError('STATE_TRANSITION_NOT_ALLOWED')).toBe(false);
  });
});
