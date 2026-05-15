import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, from, of, switchMap, throwError } from 'rxjs';
import { ModeStore } from './mode.store';

/**
 * Mutates outgoing mock HCM responses per the active adversarial mode
 * (TRD §17.3). Bypasses the `/admin/*` surface entirely — admin endpoints
 * must always respond honestly so tests can drive state regardless of mode.
 *
 *  - `reachability=off`        → 503 before reaching the handler.
 *  - `mode=flaky` (when active) → 503 (a transient HCM_UNAVAILABLE on the
 *    service side).
 *  - `mode=slow`                → sleep `slowLatencyMs`, then forward.
 *  - `mode=malformed`           → respond with non-JSON garbage.
 *  - `mode=silent_no_op`        → rewrite mutation response to `deltaApplied=0`.
 *  - `mode=wrong_delta`         → rewrite to `deltaApplied + 1`.
 *  - `mode=missing_confirmation`→ strip the txn-confirmation fields.
 *  - `mode=stale_version`       → rewrite `hcmVersion` to a value ≤ current.
 *  - `mode=version_skew`        → rewrite `hcmVersion` to a far-future value.
 */
@Injectable()
export class AdversarialModeInterceptor implements NestInterceptor {
  constructor(private readonly modes: ModeStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ readonly path?: string; readonly url?: string }>();
    const path = req.path ?? req.url ?? '';

    // Admin surface always honest.
    if (path.startsWith('/admin')) return next.handle();

    const config = this.modes.current();

    if (config.reachability === 'off') {
      return throwError(
        () =>
          new ServiceUnavailableException({
            error: 'UNREACHABLE',
            message: 'Mock HCM is configured as unreachable.',
          }),
      );
    }

    const apply = this.modes.shouldApply();
    if (!apply) return next.handle();

    if (config.mode === 'flaky') {
      return throwError(
        () =>
          new HttpException(
            { error: 'FLAKY', message: 'Simulated transient failure.' },
            503,
          ),
      );
    }

    if (config.mode === 'slow') {
      return from(sleep(config.slowLatencyMs)).pipe(switchMap(() => next.handle()));
    }

    if (config.mode === 'malformed') {
      const res = http.getResponse<Response>();
      res.status(200);
      res.setHeader('content-type', 'application/json');
      res.end('}{ not valid json');
      // Return an empty observable; the response is already written.
      return of(undefined);
    }

    return next.handle().pipe(
      switchMap((body: unknown) => {
        if (body && typeof body === 'object' && isMutationBody(body)) {
          return of(mutateBody(body, config.mode));
        }
        return of(body);
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // `.unref()` lets Node exit if this is the only thing keeping the event
    // loop alive — important when a client aborts the request (adapter
    // timeout) before the mock has finished sleeping. Without it, the test
    // process hangs waiting for the timer to fire.
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

interface MutationBody {
  transactionId?: string;
  deltaApplied?: string;
  newAvailable?: string;
  hcmVersion?: string;
  appliedAt?: string;
  [k: string]: unknown;
}

function isMutationBody(obj: object): obj is MutationBody {
  const keys = Object.keys(obj);
  return (
    keys.includes('deltaApplied') ||
    keys.includes('hcmVersion') ||
    keys.includes('transactionId')
  );
}

function mutateBody(body: MutationBody, mode: string): unknown {
  switch (mode) {
    case 'silent_no_op':
      return { ...body, deltaApplied: '0' };
    case 'wrong_delta': {
      const orig = body.deltaApplied ? Number(body.deltaApplied) : 0;
      return { ...body, deltaApplied: String(orig + 1) };
    }
    case 'missing_confirmation': {
      const stripped: Partial<MutationBody> = { ...body };
      delete stripped.transactionId;
      delete stripped.deltaApplied;
      delete stripped.newAvailable;
      return stripped;
    }
    case 'stale_version':
      return { ...body, hcmVersion: '0' };
    case 'version_skew':
      return { ...body, hcmVersion: '99999999999999999' };
    default:
      return body;
  }
}
