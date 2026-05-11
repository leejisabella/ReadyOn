import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { HcmWebhookEnvelopeSchema } from '@time-off/hcm-port';
import { InboxStore } from './inbox.store';
import { verifySignature } from './webhook-signature';

export const INBOX_SECRET = 'INBOX_WEBHOOK_SECRET';

/**
 * `POST /webhooks/hcm` — HMAC-signed inbound HCM event ingest.
 *
 *   - Signature header `X-Hcm-Signature` is verified against the raw request
 *     body using HMAC-SHA256.
 *   - Body is parsed against {@link HcmWebhookEnvelopeSchema} — malformed
 *     payloads return 400 before any state change.
 *   - Inserts an {@link InboxStore} row idempotent on `eventId` so duplicate
 *     deliveries land as silent no-ops.
 *
 * The inbox processor (a separate tick-driven worker) drains the row and
 * dispatches it to the right domain service.
 *
 * @ref docs/01_TRD.md §10.1
 * @ref docs/04_Module_Plan.md §3.12
 */
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly inbox: InboxStore,
    @Inject(INBOX_SECRET) private readonly secret: string,
  ) {}

  @Post('hcm')
  @HttpCode(202)
  ingest(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ): { readonly accepted: true; readonly deduplicated: boolean } {
    const raw = req.rawBody;
    if (!raw) {
      throw new BadRequestException({ error: 'INVALID_REQUEST', message: 'missing body' });
    }
    const signature = readHeader(req, 'x-hcm-signature');
    if (signature === null) {
      throw new UnauthorizedException({
        error: 'MISSING_SIGNATURE',
        message: 'X-Hcm-Signature header is required',
      });
    }
    if (!verifySignature(raw.toString('utf8'), signature, this.secret)) {
      throw new UnauthorizedException({
        error: 'INVALID_SIGNATURE',
        message: 'HMAC verification failed',
      });
    }

    const parsed = HcmWebhookEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'MALFORMED_WEBHOOK',
        issues: parsed.error.issues,
      });
    }

    const created = this.inbox.ingest({
      id: parsed.data.eventId,
      source: 'WEBHOOK',
      type: parsed.data.type,
      payload: parsed.data.payload as Record<string, unknown>,
      hcmVersion: parsed.data.hcmVersion,
      receivedAt: new Date().toISOString(),
    });

    return { accepted: true, deduplicated: !created };
  }
}

function readHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
  return null;
}
