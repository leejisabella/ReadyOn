import type { Database } from 'better-sqlite3';
import { DomainError } from '@time-off/domain-types';
import {
  HcmEmployeeNotFoundError,
  HcmTransientError,
  type HcmEmployeeResponse,
  type HcmPort,
} from '@time-off/hcm-port';
import { makeServiceTestDb } from '../../../test/db-helper';
import { AuditEventService } from '../../infrastructure/observability/audit-event.service';
import { AuditEventStore } from '../../infrastructure/observability/audit-event.store';
import { CorrelationContext } from '../../infrastructure/observability/correlation.context';
import { EmploymentService } from '../employment/employment.service';
import { EmploymentStore } from '../employment/employment.store';
import { EmployeeBootstrapService } from './employee-bootstrap.service';
import { EmployeeStore } from './employee.store';

function makeHcmStub(overrides: Partial<HcmPort> = {}): HcmPort {
  const notImplemented = (method: string) => () => {
    throw new Error(`HcmPort.${method} is not stubbed in this test`);
  };
  return {
    fetchBalance: notImplemented('fetchBalance') as HcmPort['fetchBalance'],
    fetchEmployment: notImplemented('fetchEmployment') as HcmPort['fetchEmployment'],
    fetchLeaveTypes: notImplemented('fetchLeaveTypes') as HcmPort['fetchLeaveTypes'],
    fetchEmployee: notImplemented('fetchEmployee') as HcmPort['fetchEmployee'],
    fetchBatch: notImplemented('fetchBatch') as HcmPort['fetchBatch'],
    reserveBalance: notImplemented('reserveBalance') as HcmPort['reserveBalance'],
    releaseBalance: notImplemented('releaseBalance') as HcmPort['releaseBalance'],
    queryTransactions: notImplemented('queryTransactions') as HcmPort['queryTransactions'],
    ...overrides,
  };
}

const sampleEmployeeResponse = (): HcmEmployeeResponse => ({
  employeeId: 'emp-1',
  hcmVersion: 7n,
  employment: [
    { locationId: 'loc-A', effectiveFrom: '2025-01-01', hcmVersion: 7n },
  ],
});

describe('EmployeeBootstrapService', () => {
  let db: Database;
  let store: EmployeeStore;
  let employment: EmploymentService;
  let audit: AuditEventStore;
  let auditService: AuditEventService;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new EmployeeStore(db);
    employment = new EmploymentService(new EmploymentStore(db));
    audit = new AuditEventStore(db);
    auditService = new AuditEventService(audit, new CorrelationContext());
  });

  afterEach(() => db.close());

  describe('ensureBootstrapped', () => {
    it('returns the existing row without touching HCM when already bootstrapped', async () => {
      store.insertIfAbsent({
        employeeId: 'emp-1',
        bootstrappedAt: '2026-05-11T10:00:00.000Z',
        bootstrapSource: 'WEBHOOK',
        hcmVersion: 1n,
        lastSeenInBatchAt: null,
      });
      const fetchEmployee = jest.fn();
      const service = new EmployeeBootstrapService(store, employment, auditService, makeHcmStub({ fetchEmployee }));
      const result = await service.ensureBootstrapped('emp-1');
      expect(result.bootstrapSource).toBe('WEBHOOK');
      expect(fetchEmployee).not.toHaveBeenCalled();
    });

    it('lazy-pulls from HCM and inserts the row + employment timeline', async () => {
      const service = new EmployeeBootstrapService(
        store,
        employment,
        auditService,
        makeHcmStub({ fetchEmployee: async () => sampleEmployeeResponse() }),
      );
      const result = await service.ensureBootstrapped('emp-1');
      expect(result.bootstrapSource).toBe('LAZY_PULL');
      expect(result.hcmVersion).toBe(7n);
      expect(employment.locationAt('emp-1', '2025-06-01')).toBe('loc-A');
    });

    it('translates HcmEmployeeNotFoundError into DomainError(EMPLOYEE_NOT_BOOTSTRAPPED) with a message naming the missing employee', async () => {
      const service = new EmployeeBootstrapService(
        store,
        employment,
        auditService,
        makeHcmStub({
          fetchEmployee: async () => {
            throw new HcmEmployeeNotFoundError('emp-ghost');
          },
        }),
      );
      try {
        await service.ensureBootstrapped('emp-ghost');
        fail('expected DomainError');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('EMPLOYEE_NOT_BOOTSTRAPPED');
        // The message identifies which employee was missing — this string is
        // surfaced to operators in error responses, so it must include the id.
        expect((err as DomainError).message).toMatch(/emp-ghost/);
      }
    });

    it('propagates transient HCM failures so the caller can retry', async () => {
      const service = new EmployeeBootstrapService(
        store,
        employment,
        auditService,
        makeHcmStub({
          fetchEmployee: async () => {
            throw new HcmTransientError('upstream timeout');
          },
        }),
      );
      await expect(service.ensureBootstrapped('emp-1')).rejects.toBeInstanceOf(HcmTransientError);
    });

    it('is idempotent under a webhook arriving mid-pull (INSERT OR IGNORE wins once)', async () => {
      // Simulate the race: the moment we resolve the HCM call, a webhook
      // also inserts the row. Both attempt insertIfAbsent — only one wins.
      const service = new EmployeeBootstrapService(
        store,
        employment,
        auditService,
        makeHcmStub({
          fetchEmployee: async () => {
            // pretend the webhook lands first
            store.insertIfAbsent({
              employeeId: 'emp-1',
              bootstrappedAt: '2026-05-11T10:00:00.000Z',
              bootstrapSource: 'WEBHOOK',
              hcmVersion: 1n,
              lastSeenInBatchAt: null,
            });
            return sampleEmployeeResponse();
          },
        }),
      );
      const result = await service.ensureBootstrapped('emp-1');
      // Webhook wrote first; lazy-pull's insert was a no-op.
      expect(result.bootstrapSource).toBe('WEBHOOK');
      expect(result.hcmVersion).toBe(1n);
    });
  });

  describe('handleEmployeeCreatedEvent', () => {
    it('inserts Employee + initial Employment from the event payload', async () => {
      const service = new EmployeeBootstrapService(store, employment, auditService, makeHcmStub());
      await service.handleEmployeeCreatedEvent({
        employeeId: 'emp-2',
        hcmVersion: 3n,
        initialEmployment: { locationId: 'loc-Z', effectiveFrom: '2026-01-01' },
      });
      const row = store.find('emp-2');
      expect(row?.bootstrapSource).toBe('WEBHOOK');
      expect(row?.hcmVersion).toBe(3n);
      expect(employment.locationAt('emp-2', '2026-06-01')).toBe('loc-Z');
    });

    it('is a no-op when the employee already exists (duplicate webhook)', async () => {
      const service = new EmployeeBootstrapService(store, employment, auditService, makeHcmStub());
      await service.handleEmployeeCreatedEvent({
        employeeId: 'emp-3',
        hcmVersion: 1n,
        initialEmployment: { locationId: 'loc-A', effectiveFrom: '2026-01-01' },
      });
      await service.handleEmployeeCreatedEvent({
        employeeId: 'emp-3',
        hcmVersion: 2n, // newer version — but employee identity stays anchored to first write
        initialEmployment: { locationId: 'loc-B', effectiveFrom: '2026-01-01' },
      });
      const row = store.find('emp-3');
      expect(row?.hcmVersion).toBe(1n); // first writer wins on Employee row identity
      // Employment, however, IS version-gated and reflects the newer payload.
      expect(employment.locationAt('emp-3', '2026-06-01')).toBe('loc-B');
    });
  });

  describe('EMPLOYEE_BOOTSTRAPPED audit emission (TRD §11.2)', () => {
    function listBootstrapAudits(employeeId: string): Array<{ actor: string; after: unknown }> {
      return audit
        .findByEntity('Employee', employeeId)
        .filter((row) => row.action === 'EMPLOYEE_BOOTSTRAPPED')
        .map((row) => ({ actor: row.actor, after: row.after }));
    }

    it('emits exactly once with actor=inbox after a successful WEBHOOK bootstrap; emits zero times on a duplicate', async () => {
      const service = new EmployeeBootstrapService(store, employment, auditService, makeHcmStub());
      await service.handleEmployeeCreatedEvent({
        employeeId: 'emp-wh',
        hcmVersion: 1n,
        initialEmployment: { locationId: 'loc-A', effectiveFrom: '2026-01-01' },
      });
      // second delivery loses INSERT OR IGNORE → must not re-emit
      await service.handleEmployeeCreatedEvent({
        employeeId: 'emp-wh',
        hcmVersion: 2n,
        initialEmployment: { locationId: 'loc-A', effectiveFrom: '2026-01-01' },
      });
      const events = listBootstrapAudits('emp-wh');
      expect(events).toHaveLength(1);
      expect(events[0]!.actor).toBe('inbox');
      expect(events[0]!.after).toEqual({ source: 'WEBHOOK' });
    });

    it('emits with actor=saga on a LAZY_PULL bootstrap', async () => {
      const service = new EmployeeBootstrapService(
        store,
        employment,
        auditService,
        makeHcmStub({ fetchEmployee: async () => sampleEmployeeResponse() }),
      );
      await service.ensureBootstrapped('emp-1');
      const events = listBootstrapAudits('emp-1');
      expect(events).toHaveLength(1);
      expect(events[0]!.actor).toBe('saga');
      expect(events[0]!.after).toEqual({ source: 'LAZY_PULL' });
    });

    it('emits with actor=batch-reconciler on a BATCH bootstrap', async () => {
      const service = new EmployeeBootstrapService(store, employment, auditService, makeHcmStub());
      await service.bootstrapFromBatch({ employeeId: 'emp-batch', hcmVersion: 1n });
      // second batch tick on the same employee must not re-emit
      await service.bootstrapFromBatch({ employeeId: 'emp-batch', hcmVersion: 1n });
      const events = listBootstrapAudits('emp-batch');
      expect(events).toHaveLength(1);
      expect(events[0]!.actor).toBe('batch-reconciler');
      expect(events[0]!.after).toEqual({ source: 'BATCH' });
    });

    it('does not emit when lazy-pull loses an insert race to a concurrent WEBHOOK', async () => {
      const service = new EmployeeBootstrapService(
        store,
        employment,
        auditService,
        makeHcmStub({
          fetchEmployee: async () => {
            store.insertIfAbsent({
              employeeId: 'emp-1',
              bootstrappedAt: '2026-05-11T10:00:00.000Z',
              bootstrapSource: 'WEBHOOK',
              hcmVersion: 1n,
              lastSeenInBatchAt: null,
            });
            return sampleEmployeeResponse();
          },
        }),
      );
      await service.ensureBootstrapped('emp-1');
      // The race-winning WEBHOOK insert came from raw `store.insertIfAbsent`,
      // not via the service — so there should be ZERO audit events here.
      expect(listBootstrapAudits('emp-1')).toHaveLength(0);
    });
  });

  describe('bootstrapFromBatch', () => {
    it('inserts a new employee with source=BATCH and stamps lastSeenInBatchAt', async () => {
      const service = new EmployeeBootstrapService(store, employment, auditService, makeHcmStub());
      await service.bootstrapFromBatch({ employeeId: 'emp-batch', hcmVersion: 10n });
      const row = store.find('emp-batch');
      expect(row?.bootstrapSource).toBe('BATCH');
      expect(row?.lastSeenInBatchAt).not.toBeNull();
    });

    it('only updates lastSeenInBatchAt on subsequent calls for an existing employee', async () => {
      const service = new EmployeeBootstrapService(store, employment, auditService, makeHcmStub());
      await service.handleEmployeeCreatedEvent({
        employeeId: 'emp-known',
        hcmVersion: 1n,
        initialEmployment: { locationId: 'loc-A', effectiveFrom: '2026-01-01' },
      });
      const before = store.find('emp-known');
      expect(before?.bootstrapSource).toBe('WEBHOOK');
      expect(before?.lastSeenInBatchAt).toBeNull();

      await service.bootstrapFromBatch({ employeeId: 'emp-known', hcmVersion: 5n });
      const after = store.find('emp-known');
      expect(after?.bootstrapSource).toBe('WEBHOOK'); // unchanged — INSERT OR IGNORE
      expect(after?.hcmVersion).toBe(1n); // unchanged
      expect(after?.lastSeenInBatchAt).not.toBeNull();
    });
  });
});
