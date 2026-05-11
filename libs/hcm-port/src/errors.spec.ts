import { z } from 'zod';
import {
  HcmContractViolation,
  HcmEmployeeNotFoundError,
  HcmError,
  HcmPermanentError,
  HcmTransientError,
} from './errors';

describe('HcmError hierarchy', () => {
  it('every concrete class extends HcmError and Error', () => {
    const instances = [
      new HcmTransientError('boom'),
      new HcmPermanentError('OTHER', 'nope'),
      new HcmContractViolation('bad shape', []),
      new HcmEmployeeNotFoundError('emp-1'),
    ];
    for (const e of instances) {
      expect(e).toBeInstanceOf(HcmError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('each subclass has its own constructor name (so logs disambiguate)', () => {
    expect(new HcmTransientError('').name).toBe('HcmTransientError');
    expect(new HcmPermanentError('OTHER', '').name).toBe('HcmPermanentError');
    expect(new HcmContractViolation('', []).name).toBe('HcmContractViolation');
    expect(new HcmEmployeeNotFoundError('e').name).toBe('HcmEmployeeNotFoundError');
  });

  it('retryable flag matches the routing contract', () => {
    expect(new HcmTransientError('').retryable).toBe(true);
    expect(new HcmPermanentError('OTHER', '').retryable).toBe(false);
    expect(new HcmContractViolation('', []).retryable).toBe(false);
    expect(new HcmEmployeeNotFoundError('e').retryable).toBe(false);
  });
});

describe('HcmTransientError', () => {
  it('preserves the cause chain (ES2022 Error cause)', () => {
    const root = new Error('socket hang up');
    const err = new HcmTransientError('upstream timed out', { cause: root });
    expect(err.cause).toBe(root);
  });

  it('records an optional Retry-After hint', () => {
    expect(new HcmTransientError('rate limit', { retryAfterMs: 5_000 }).retryAfterMs).toBe(5_000);
    expect(new HcmTransientError('rate limit').retryAfterMs).toBeUndefined();
  });
});

describe('HcmPermanentError', () => {
  it('discriminates by `reason` (downstream routes without parsing the message)', () => {
    expect(new HcmPermanentError('INSUFFICIENT_BALANCE', 'nope').reason).toBe('INSUFFICIENT_BALANCE');
    expect(new HcmPermanentError('INVALID_DIMENSION', 'nope').reason).toBe('INVALID_DIMENSION');
    expect(new HcmPermanentError('AUTH_FAILED', 'nope').reason).toBe('AUTH_FAILED');
  });
});

describe('HcmContractViolation', () => {
  it('carries zodIssues so HCM_RESPONSE_INVALID can be diagnosed in audit', () => {
    const issues: z.ZodIssue[] = [
      { code: z.ZodIssueCode.custom, path: ['deltaApplied'], message: 'Required' },
    ];
    const err = new HcmContractViolation('shape mismatch', issues);
    expect(err.zodIssues).toEqual(issues);
  });
});

describe('HcmEmployeeNotFoundError (Rev 3.1, Q.ν)', () => {
  it('extends HcmPermanentError so generic retryable checks treat it as terminal', () => {
    const err = new HcmEmployeeNotFoundError('emp-deleted');
    expect(err).toBeInstanceOf(HcmPermanentError);
    expect(err.retryable).toBe(false);
  });

  it('carries the employeeId so the reconciler can include it in the ReconciliationStep payload', () => {
    const err = new HcmEmployeeNotFoundError('emp-deleted');
    expect(err.employeeId).toBe('emp-deleted');
  });

  it('discriminable from a generic permanent error via instanceof', () => {
    const generic: HcmPermanentError = new HcmPermanentError('OTHER', 'something else');
    const employeeGone: HcmPermanentError = new HcmEmployeeNotFoundError('e');
    expect(generic instanceof HcmEmployeeNotFoundError).toBe(false);
    expect(employeeGone instanceof HcmEmployeeNotFoundError).toBe(true);
  });

  it('uses a default message when none is supplied', () => {
    expect(new HcmEmployeeNotFoundError('emp-9').message).toMatch(/emp-9/);
  });
});
