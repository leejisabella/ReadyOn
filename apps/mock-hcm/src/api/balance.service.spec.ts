import type { Database } from 'better-sqlite3';
import Decimal from 'decimal.js';
import { makeTestDb } from '../../test/db-helper';
import { BalanceStore } from '../persistence/balance.store';
import { EmployeeStore } from '../persistence/employee.store';
import { TransactionStore } from '../persistence/transaction.store';
import { VersionStore } from '../persistence/version.store';
import { BalanceService, type MutationRequest } from './balance.service';

const baseRequest = (overrides: Partial<MutationRequest> = {}): MutationRequest => ({
  employeeId: 'emp-1',
  locationId: 'loc-1',
  leaveTypeId: 'pto',
  units: new Decimal('2'),
  idempotencyKey: 'idem-default',
  ...overrides,
});

describe('BalanceService', () => {
  let db: Database;
  let balances: BalanceStore;
  let employees: EmployeeStore;
  let transactions: TransactionStore;
  let versions: VersionStore;
  let service: BalanceService;

  beforeEach(() => {
    db = makeTestDb();
    balances = new BalanceStore(db);
    employees = new EmployeeStore(db);
    transactions = new TransactionStore(db);
    versions = new VersionStore(db);
    service = new BalanceService(balances, employees, transactions, versions);

    employees.insert({ employeeId: 'emp-1', hcmVersion: versions.next(), createdAt: '2026-01-01T00:00:00.000Z' });
    balances.upsert({
      employeeId: 'emp-1',
      locationId: 'loc-1',
      leaveTypeId: 'pto',
      available: new Decimal('10'),
      hcmVersion: versions.next(),
      appliedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => db.close());

  describe('reserve — happy path', () => {
    it('debits the balance and returns the full mutation confirmation (TRD §13.2)', () => {
      const outcome = service.reserve(baseRequest({ units: new Decimal('3') }));
      expect(outcome.kind).toBe('ACCEPTED');
      expect(outcome.statusCode).toBe(200);
      if (outcome.kind !== 'ACCEPTED') return;
      expect(outcome.body.deltaApplied).toBe('-3');
      expect(outcome.body.newAvailable).toBe('7');
      expect(outcome.body.transactionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(outcome.body.hcmVersion).toMatch(/^\d+$/);

      expect(balances.find('emp-1', 'loc-1', 'pto')!.available.toFixed()).toBe('7');
    });

    it('records an ACCEPTED transaction visible via the transaction store', () => {
      service.reserve(baseRequest({ idempotencyKey: 'tx-key' }));
      const found = transactions.findByIdempotencyKey('tx-key');
      expect(found?.outcome).toBe('ACCEPTED');
      expect(found?.deltaApplied.toFixed()).toBe('-2');
    });
  });

  describe('reserve — rejections', () => {
    it('returns INSUFFICIENT_BALANCE (400) when units exceed availability', () => {
      const outcome = service.reserve(baseRequest({ units: new Decimal('11') }));
      expect(outcome.kind).toBe('REJECTED');
      expect(outcome.statusCode).toBe(400);
      if (outcome.kind !== 'REJECTED') return;
      expect(outcome.body.error).toBe('INSUFFICIENT_BALANCE');
      expect(balances.find('emp-1', 'loc-1', 'pto')!.available.toFixed()).toBe('10');
    });

    it('returns INVALID_DIMENSION (400) when the balance row is missing', () => {
      const outcome = service.reserve(
        baseRequest({ leaveTypeId: 'sick', idempotencyKey: 'idem-sick' }),
      );
      expect(outcome.kind).toBe('REJECTED');
      expect(outcome.statusCode).toBe(400);
      if (outcome.kind !== 'REJECTED') return;
      expect(outcome.body.error).toBe('INVALID_DIMENSION');
    });

    it('returns EMPLOYEE_NOT_FOUND (404) when the employee was deleted (Q.ν)', () => {
      employees.delete('emp-1');
      const outcome = service.reserve(baseRequest({ idempotencyKey: 'idem-after-delete' }));
      expect(outcome.kind).toBe('REJECTED');
      expect(outcome.statusCode).toBe(404);
      if (outcome.kind !== 'REJECTED') return;
      expect(outcome.body.error).toBe('EMPLOYEE_NOT_FOUND');
    });

    it('records rejections so idempotent replay returns the same outcome', () => {
      service.reserve(baseRequest({ units: new Decimal('11'), idempotencyKey: 'rej-1' }));
      const replay = service.reserve(baseRequest({ units: new Decimal('11'), idempotencyKey: 'rej-1' }));
      expect(replay.kind).toBe('REJECTED');
      expect(replay.statusCode).toBe(400);
    });
  });

  describe('release — happy path', () => {
    it('credits the balance', () => {
      const outcome = service.release(baseRequest({ units: new Decimal('4'), idempotencyKey: 'rel-1' }));
      expect(outcome.kind).toBe('ACCEPTED');
      if (outcome.kind !== 'ACCEPTED') return;
      expect(outcome.body.deltaApplied).toBe('4');
      expect(outcome.body.newAvailable).toBe('14');
    });

    it('never produces INSUFFICIENT_BALANCE on a credit', () => {
      // Even with 1000 units, credit always succeeds (delta is positive).
      const outcome = service.release(baseRequest({ units: new Decimal('1000'), idempotencyKey: 'rel-big' }));
      expect(outcome.kind).toBe('ACCEPTED');
    });
  });

  describe('idempotent replay (TRD §14.1, ADR-008)', () => {
    it('returns the prior ACCEPTED response verbatim on retry', () => {
      const first = service.reserve(baseRequest({ idempotencyKey: 'replay-ok' }));
      const second = service.reserve(baseRequest({ idempotencyKey: 'replay-ok' }));
      expect(first).toEqual(second);
    });

    it('does NOT apply the delta a second time', () => {
      service.reserve(baseRequest({ units: new Decimal('3'), idempotencyKey: 'no-double-debit' }));
      service.reserve(baseRequest({ units: new Decimal('3'), idempotencyKey: 'no-double-debit' }));
      expect(balances.find('emp-1', 'loc-1', 'pto')!.available.toFixed()).toBe('7');
    });

    it('advances hcmVersion by exactly one across the two retried calls', () => {
      const before = versions.current();
      service.reserve(baseRequest({ idempotencyKey: 'replay-version' }));
      service.reserve(baseRequest({ idempotencyKey: 'replay-version' }));
      service.reserve(baseRequest({ idempotencyKey: 'replay-version' }));
      expect(versions.current() - before).toBe(1n);
    });
  });

  describe('hcmVersion ordering (TRD §10.1)', () => {
    it('issues strictly-increasing versions across distinct mutations', () => {
      const first = service.reserve(baseRequest({ idempotencyKey: 'v-1' }));
      const second = service.release(baseRequest({ idempotencyKey: 'v-2' }));
      if (first.kind !== 'ACCEPTED' || second.kind !== 'ACCEPTED') {
        throw new Error('expected both ACCEPTED');
      }
      expect(BigInt(second.body.hcmVersion)).toBeGreaterThan(BigInt(first.body.hcmVersion));
    });
  });
});
