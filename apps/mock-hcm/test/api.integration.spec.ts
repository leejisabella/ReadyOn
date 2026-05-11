import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { MockHcmModule } from '../src/app.module';

type Agent = ReturnType<typeof supertest>;

describe('Mock HCM HTTP API (TRD §17.2)', () => {
  let app: INestApplication;
  let http: Agent;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MockHcmModule.forRoot({ dbPath: ':memory:' })],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    http = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await http.post('/admin/reset').expect(204);
    await http.post('/admin/createEmployee').send({ employeeId: 'emp-1' }).expect(204);
    await http
      .post('/admin/setEmployment')
      .send({ employeeId: 'emp-1', locationId: 'loc-1', effectiveFrom: '2025-01-01' })
      .expect(204);
    await http
      .post('/admin/setLeaveTypeAvailability')
      .send({ locationId: 'loc-1', leaveTypeId: 'pto', isActive: true, effectiveFrom: '2025-01-01' })
      .expect(204);
    await http
      .post('/admin/setBalance')
      .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', available: '10' })
      .expect(204);
  });

  // ── Reads ────────────────────────────────────────────────────────────────

  describe('GET /balances/:e/:l/:t', () => {
    it('returns the seeded balance with the contract fields', async () => {
      const res = await http.get('/balances/emp-1/loc-1/pto').expect(200);
      expect(res.body).toMatchObject({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        leaveTypeId: 'pto',
        available: '10',
      });
      expect(res.body.hcmVersion).toMatch(/^\d+$/);
      expect(res.body.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
      const res = await http.get('/balances/ghost/loc-1/pto').expect(404);
      expect(res.body.error).toBe('EMPLOYEE_NOT_FOUND');
    });

    it('returns 404 INVALID_DIMENSION when the balance is unset for a known employee', async () => {
      const res = await http.get('/balances/emp-1/loc-1/sick').expect(404);
      expect(res.body.error).toBe('INVALID_DIMENSION');
    });
  });

  describe('GET /employment/:e', () => {
    it('returns the seeded employment timeline', async () => {
      const res = await http.get('/employment/emp-1').expect(200);
      expect(res.body.employeeId).toBe('emp-1');
      expect(res.body.periods).toHaveLength(1);
      expect(res.body.periods[0]).toMatchObject({ locationId: 'loc-1', effectiveFrom: '2025-01-01' });
    });

    it('returns 404 for an unknown employee', async () => {
      await http.get('/employment/ghost').expect(404);
    });
  });

  describe('GET /leaveTypes/:l', () => {
    it('lists active types for a location', async () => {
      const res = await http.get('/leaveTypes/loc-1').expect(200);
      expect(res.body.leaveTypes).toHaveLength(1);
      expect(res.body.leaveTypes[0]).toMatchObject({ leaveTypeId: 'pto', isActive: true });
    });
  });

  describe('GET /employees/:e', () => {
    it('returns the employee with their employment', async () => {
      const res = await http.get('/employees/emp-1').expect(200);
      expect(res.body.employeeId).toBe('emp-1');
      expect(res.body.employment).toHaveLength(1);
    });

    it('returns 404 for an unknown employee', async () => {
      await http.get('/employees/ghost').expect(404);
    });
  });

  // ── Mutations + idempotency ──────────────────────────────────────────────

  describe('POST /balances/reserve', () => {
    it('applies a debit and returns the full mutation confirmation', async () => {
      const res = await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'reserve-1')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '3' })
        .expect(200);
      expect(res.body).toMatchObject({ deltaApplied: '-3', newAvailable: '7' });
      expect(res.body.transactionId).toMatch(/^[0-9a-f-]{36}$/);

      const after = await http.get('/balances/emp-1/loc-1/pto').expect(200);
      expect(after.body.available).toBe('7');
    });

    it('replays the prior response on retry with the same Idempotency-Key', async () => {
      const first = await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'replay-key')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '3' })
        .expect(200);
      const second = await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'replay-key')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '3' })
        .expect(200);
      expect(second.body).toEqual(first.body);

      const after = await http.get('/balances/emp-1/loc-1/pto').expect(200);
      expect(after.body.available).toBe('7'); // not double-debited
    });

    it('returns 400 INSUFFICIENT_BALANCE when units exceed availability', async () => {
      const res = await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'reserve-too-much')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '99' })
        .expect(400);
      expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
    });

    it('returns 404 EMPLOYEE_NOT_FOUND after the employee is deleted (Q.ν)', async () => {
      await http.post('/admin/deleteEmployee').send({ employeeId: 'emp-1' }).expect(204);
      const res = await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'after-delete')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '1' })
        .expect(404);
      expect(res.body.error).toBe('EMPLOYEE_NOT_FOUND');
    });

    it('returns 400 when Idempotency-Key header is missing', async () => {
      await http
        .post('/balances/reserve')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '1' })
        .expect(400);
    });

    it('returns 400 when the body fails validation', async () => {
      await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'bad-body')
        .send({ employeeId: 'emp-1' })
        .expect(400);
    });
  });

  describe('POST /balances/release', () => {
    it('credits the balance', async () => {
      const res = await http
        .post('/balances/release')
        .set('Idempotency-Key', 'release-1')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '4' })
        .expect(200);
      expect(res.body).toMatchObject({ deltaApplied: '4', newAvailable: '14' });
    });
  });

  // ── Transactions (Rev 3, §13.2.1) ────────────────────────────────────────

  describe('POST /transactions/query', () => {
    beforeEach(async () => {
      await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'action-1')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '2' })
        .expect(200);
      await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'action-2')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '1' })
        .expect(200);
    });

    it('returns ACCEPTED transactions matching the dimension filter', async () => {
      const res = await http
        .post('/transactions/query')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto' })
        .expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ idempotencyKey: 'action-1', deltaApplied: '-2' });
    });

    it('filters by idempotency key — used by the provisional reconciler', async () => {
      const res = await http
        .post('/transactions/query')
        .send({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          leaveTypeId: 'pto',
          idempotencyKey: 'action-2',
        })
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].idempotencyKey).toBe('action-2');
    });

    it('returns 404 EMPLOYEE_NOT_FOUND when the queried employee is unknown (Q.ν)', async () => {
      const res = await http
        .post('/transactions/query')
        .send({ employeeId: 'ghost', locationId: 'loc-1', leaveTypeId: 'pto' })
        .expect(404);
      expect(res.body.error).toBe('EMPLOYEE_NOT_FOUND');
    });
  });

  // ── Batch (TRD §10.2) ────────────────────────────────────────────────────

  describe('GET /balances/batch', () => {
    it('streams every balance row as NDJSON', async () => {
      await http
        .post('/admin/setBalance')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'sick', available: '5' })
        .expect(204);

      const res = await http.get('/balances/batch').expect(200);
      expect(res.headers['content-type']).toContain('application/x-ndjson');
      const lines = res.text.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.map((r) => r.leaveTypeId).sort()).toEqual(['pto', 'sick']);
    });
  });

  // ── Admin surface ────────────────────────────────────────────────────────

  describe('Admin endpoints', () => {
    it('GET /admin/state dumps every store for tests to inspect', async () => {
      await http
        .post('/balances/reserve')
        .set('Idempotency-Key', 'state-tx')
        .send({ employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', units: '2' })
        .expect(200);
      const res = await http.get('/admin/state').expect(200);
      expect(res.body.employees).toHaveLength(1);
      expect(res.body.balances).toHaveLength(1);
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.currentHcmVersion).toMatch(/^\d+$/);
    });

    it('POST /admin/reset wipes every store', async () => {
      await http.post('/admin/reset').expect(204);
      const res = await http.get('/admin/state').expect(200);
      expect(res.body.employees).toEqual([]);
      expect(res.body.balances).toEqual([]);
      expect(res.body.transactions).toEqual([]);
      expect(res.body.currentHcmVersion).toBe('0');
    });

    it('admin setters are idempotent', async () => {
      await http.post('/admin/createEmployee').send({ employeeId: 'emp-1' }).expect(204);
      await http.post('/admin/createEmployee').send({ employeeId: 'emp-1' }).expect(204);
      const state = await http.get('/admin/state').expect(200);
      const matches = state.body.employees.filter((e: { employeeId: string }) => e.employeeId === 'emp-1');
      expect(matches).toHaveLength(1);
    });
  });
});
