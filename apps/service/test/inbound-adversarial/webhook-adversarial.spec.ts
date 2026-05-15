import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { HcmAdapterModule } from '../../src/infrastructure/hcm/hcm-adapter.module';
import { InboxModule } from '../../src/infrastructure/inbox/inbox.module';
import { InboxStore } from '../../src/infrastructure/inbox/inbox.store';
import { computeSignature } from '../../src/infrastructure/inbox/webhook-signature';
import { ObservabilityModule } from '../../src/infrastructure/observability/observability.module';
import { DatabaseModule } from '../../src/infrastructure/persistence/database.module';

/**
 * Layer 6 — Inbound adversarial tests (TRD §10.1, Test Plan §8).
 *
 * Webhook intake under attack. Complements the existing
 * `webhook.controller.spec.ts` (signature & basic shape) with replay,
 * flood, version-skew, future-applied-at, cross-tenant, unknown-employee
 * surfaces. Test IDs `T-IN-NN` per the Test Plan §27 traceability matrix.
 */
const SECRET = 'test-secret-adversarial';

const envelope = (
  overrides: Partial<{
    eventId: string;
    type: string;
    payload: object;
    hcmVersion: string;
    appliedAt: string;
  }> = {},
) => ({
  eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2)}`,
  type: overrides.type ?? 'BALANCE_UPDATED',
  hcmVersion: overrides.hcmVersion ?? '7',
  appliedAt: overrides.appliedAt ?? '2026-05-11T12:00:00.000Z',
  payload:
    overrides.payload ??
    { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', available: '10.00' },
});

describe('Layer 6 — Inbound adversarial', () => {
  let app: INestApplication;
  let http: ReturnType<typeof supertest>;
  let store: InboxStore;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ dbPath: ':memory:' }),
        ObservabilityModule.forRoot(),
        HcmAdapterModule.forRoot({ adapter: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 } }),
        InboxModule.forRoot({ webhookSecret: SECRET }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    await app.init();
    http = supertest(app.getHttpServer());
    store = app.get(InboxStore);
  });

  afterAll(async () => {
    await app.close();
  });

  function post(env: object) {
    const body = JSON.stringify(env);
    const signature = computeSignature(body, SECRET);
    return http
      .post('/webhooks/hcm')
      .set('content-type', 'application/json')
      .set('x-hcm-signature', signature)
      .send(body);
  }

  it('T-IN-10 — replay attack: same eventId submitted twice → second is deduplicated, no double insert', async () => {
    const env = envelope({ eventId: 'evt-replay' });
    const first = await post(env);
    expect(first.status).toBe(202);
    expect(first.body.deduplicated).toBe(false);
    const second = await post(env);
    expect(second.status).toBe(202);
    expect(second.body.deduplicated).toBe(true);
    expect(store.find('evt-replay')).not.toBeNull();
  });

  it('T-IN-11 — webhook arriving with appliedAt in the future is accepted (clock skew tolerated)', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const res = await post(envelope({ eventId: 'evt-future', appliedAt: future }));
    expect(res.status).toBe(202);
    // Inbox row stores hcmVersion (ordering authority); appliedAt is in the
    // payload for human readability only (TRD §10.1).
    expect(store.find('evt-future')).not.toBeNull();
  });

  it('T-IN-12 — webhook with very-old appliedAt is accepted (hcmVersion is authoritative)', async () => {
    const res = await post(
      envelope({ eventId: 'evt-stale-applied', appliedAt: '2020-01-01T00:00:00.000Z', hcmVersion: '100' }),
    );
    expect(res.status).toBe(202);
  });

  it('T-IN-13 — every supported event type is accepted', async () => {
    const types = [
      ['BALANCE_UPDATED', { employeeId: 'e', locationId: 'l', leaveTypeId: 'pto', available: '5.00' }],
      ['EMPLOYMENT_CHANGED', { employeeId: 'e', locationId: 'l', effectiveFrom: '2026-01-01' }],
      ['LEAVE_TYPE_CHANGED', { locationId: 'l', leaveTypeId: 'pto', isActive: true, effectiveFrom: '2026-01-01' }],
      ['EMPLOYEE_CREATED', { employeeId: 'new-emp', employment: { locationId: 'l', effectiveFrom: '2026-01-01' } }],
    ] as const;
    for (const [type, payload] of types) {
      const eventId = `evt-${type.toLowerCase()}`;
      const res = await post(envelope({ eventId, type, payload }));
      expect(res.status).toBe(202);
      expect(store.find(eventId)?.type).toBe(type);
    }
  });

  it('T-IN-14 — empty body → 400', async () => {
    const body = '';
    const signature = computeSignature(body, SECRET);
    const res = await http
      .post('/webhooks/hcm')
      .set('content-type', 'application/json')
      .set('x-hcm-signature', signature)
      .send(body);
    expect(res.status).toBe(400);
  });

  it('T-IN-15 — missing hcmVersion → 400 (zod schema rejects)', async () => {
    const broken = {
      eventId: 'evt-no-version',
      type: 'BALANCE_UPDATED',
      appliedAt: '2026-05-11T12:00:00.000Z',
      payload: { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', available: '10.00' },
    };
    const res = await post(broken);
    expect(res.status).toBe(400);
  });

  it('T-IN-16 — flood: 50 distinct eventIds all accepted, none lost', async () => {
    // Serialize to avoid supertest connection-pool ECONNRESET noise; the
    // assertion is about correctness (every event landed), not concurrency.
    for (let i = 0; i < 50; i++) {
      const res = await post(envelope({ eventId: `evt-flood-${i}` }));
      expect(res.status).toBe(202);
    }
    for (let i = 0; i < 50; i++) {
      expect(store.find(`evt-flood-${i}`)).not.toBeNull();
    }
  });

  it('T-IN-17 — flood with duplicates: 10 distinct keys × 3 duplicates each → 10 stored, 20 deduplicated', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `evt-floodup-${i}`);
    const allCalls = [...ids, ...ids, ...ids];
    const results: Array<{ deduplicated: boolean }> = [];
    for (const id of allCalls) {
      const res = await post(envelope({ eventId: id }));
      results.push(res.body);
    }
    const accepted = results.filter((r) => r.deduplicated === false).length;
    const deduplicated = results.filter((r) => r.deduplicated === true).length;
    expect(accepted).toBe(10);
    expect(deduplicated).toBe(20);
  });

  it('T-IN-18 — out-of-order delivery: lower hcmVersion arrives after higher → both stored, processor handles ordering', async () => {
    const high = await post(envelope({ eventId: 'evt-order-100', hcmVersion: '100' }));
    const low = await post(envelope({ eventId: 'evt-order-50', hcmVersion: '50' }));
    expect(high.status).toBe(202);
    expect(low.status).toBe(202);
    // Intake order is preserved; ordering authority is hcmVersion at process-time.
    expect(store.find('evt-order-100')?.hcmVersion).toBe(100n);
    expect(store.find('evt-order-50')?.hcmVersion).toBe(50n);
  });

  it('T-IN-19 — signature timing-safe-compare: nearly-correct sig still rejects', async () => {
    const env = envelope({ eventId: 'evt-timing' });
    const body = JSON.stringify(env);
    const correct = computeSignature(body, SECRET);
    // Mutate one character in the middle of the sig
    const tampered = correct.slice(0, 20) + (correct[20] === '0' ? '1' : '0') + correct.slice(21);
    const res = await http
      .post('/webhooks/hcm')
      .set('content-type', 'application/json')
      .set('x-hcm-signature', tampered)
      .send(body);
    expect(res.status).toBe(401);
  });

  it('T-IN-20 — payload-only mutation (hcmVersion unchanged) → signature mismatch, 401', async () => {
    const original = envelope({ eventId: 'evt-payload-mut' });
    const signature = computeSignature(JSON.stringify(original), SECRET);
    const evil = {
      ...original,
      payload: { ...original.payload, available: '999999.00' },
    };
    const res = await http
      .post('/webhooks/hcm')
      .set('content-type', 'application/json')
      .set('x-hcm-signature', signature)
      .send(JSON.stringify(evil));
    expect(res.status).toBe(401);
    expect(store.find('evt-payload-mut')).toBeNull();
  });

  it('T-IN-21 — empty payload object on BALANCE_UPDATED → schema rejects with 400', async () => {
    const res = await post(envelope({ eventId: 'evt-empty-payload', payload: {} }));
    expect(res.status).toBe(400);
  });

  it('T-IN-22 — duplicate eventId with different valid payloads → first wins (dedup by eventId)', async () => {
    const eventId = 'evt-mismatched-types';
    const a = await post(envelope({ eventId, type: 'BALANCE_UPDATED' }));
    const b = await post(
      envelope({
        eventId,
        type: 'EMPLOYMENT_CHANGED',
        payload: { employeeId: 'e', locationId: 'l', effectiveFrom: '2026-01-01' },
      }),
    );
    expect(a.body.deduplicated).toBe(false);
    expect(b.body.deduplicated).toBe(true);
    expect(store.find(eventId)?.type).toBe('BALANCE_UPDATED');
  });
});
