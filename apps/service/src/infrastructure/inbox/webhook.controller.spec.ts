import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { HcmAdapterModule } from '../hcm/hcm-adapter.module';
import { DatabaseModule } from '../persistence/database.module';
import { InboxModule } from './inbox.module';
import { InboxStore } from './inbox.store';
import { computeSignature } from './webhook-signature';

const SECRET = 'test-secret-shhh';

const validEnvelope = (
  overrides: Partial<{ eventId: string; type: string; payload: object; hcmVersion: string }> = {},
) => ({
  eventId: overrides.eventId ?? 'evt-1',
  type: overrides.type ?? 'BALANCE_UPDATED',
  hcmVersion: overrides.hcmVersion ?? '7',
  appliedAt: '2026-05-11T12:00:00.000Z',
  payload:
    overrides.payload ??
    { employeeId: 'emp-1', locationId: 'loc-1', leaveTypeId: 'pto', available: '10.00' },
});

describe('WebhookController (POST /webhooks/hcm)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof supertest>;
  let store: InboxStore;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ dbPath: ':memory:' }),
        HcmAdapterModule.forRoot({
          adapter: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 },
        }),
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

  function post(envelope: object) {
    const body = JSON.stringify(envelope);
    const signature = computeSignature(body, SECRET);
    return http
      .post('/webhooks/hcm')
      .set('content-type', 'application/json')
      .set('x-hcm-signature', signature)
      .send(body);
  }

  it('accepts a valid envelope and creates an inbox row (202)', async () => {
    const res = await post(validEnvelope({ eventId: 'evt-ok' }));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true, deduplicated: false });
    expect(store.find('evt-ok')?.type).toBe('BALANCE_UPDATED');
  });

  it('returns `deduplicated: true` on duplicate delivery (idempotent)', async () => {
    await post(validEnvelope({ eventId: 'evt-dup' }));
    const second = await post(validEnvelope({ eventId: 'evt-dup' }));
    expect(second.status).toBe(202);
    expect(second.body.deduplicated).toBe(true);
  });

  it('rejects an invalid signature with 401', async () => {
    const body = JSON.stringify(validEnvelope({ eventId: 'evt-bad-sig' }));
    const res = await http
      .post('/webhooks/hcm')
      .set('content-type', 'application/json')
      .set('x-hcm-signature', 'deadbeef'.repeat(8))
      .send(body);
    expect(res.status).toBe(401);
    expect(store.find('evt-bad-sig')).toBeNull();
  });

  it('rejects a request with no signature header with 401', async () => {
    const body = JSON.stringify(validEnvelope({ eventId: 'evt-no-sig' }));
    const res = await http.post('/webhooks/hcm').set('content-type', 'application/json').send(body);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered body (signature computed against original)', async () => {
    const original = validEnvelope({ eventId: 'evt-tamper' });
    const signature = computeSignature(JSON.stringify(original), SECRET);
    const tampered = { ...original, payload: { ...original.payload, available: '999999.00' } };
    const res = await http
      .post('/webhooks/hcm')
      .set('content-type', 'application/json')
      .set('x-hcm-signature', signature)
      .send(JSON.stringify(tampered));
    expect(res.status).toBe(401);
  });

  it('rejects a malformed envelope with 400', async () => {
    const res = await post({ not: 'a valid envelope' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown event type with 400', async () => {
    const res = await post(validEnvelope({ type: 'SOMETHING_NEW' }));
    expect(res.status).toBe(400);
  });
});
