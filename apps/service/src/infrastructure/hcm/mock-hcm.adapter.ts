import { Injectable } from '@nestjs/common';
import {
  HcmBatchEntrySchema,
  HcmContractViolation,
  HcmEmployeeNotFoundError,
  HcmEmployeeResponseSchema,
  HcmEmploymentResponseSchema,
  HcmFetchBalanceResponseSchema,
  HcmLeaveTypesResponseSchema,
  HcmMutationResponseSchema,
  HcmPermanentError,
  HcmTransactionHistorySchema,
  HcmTransientError,
  type FetchBalanceArgs,
  type HcmBatchEntry,
  type HcmEmployeeResponse,
  type HcmEmploymentResponse,
  type HcmFetchBalanceResponse,
  type HcmLeaveTypesResponse,
  type HcmMutationResponse,
  type HcmPermanentReason,
  type HcmPort,
  type HcmTransactionQuery,
  type HcmTransactionRecord,
  type ReleaseBalanceArgs,
  type ReserveBalanceArgs,
} from '@time-off/hcm-port';
import { z } from 'zod';
import { HcmHealthMonitor } from './hcm-health.monitor';

/**
 * HTTP adapter that implements {@link HcmPort} against the Mock HCM.
 *
 * Responsibilities (matching Module Plan §3.9):
 *   - Translate port calls into HTTP requests.
 *   - Apply per-call timeout via `AbortController`.
 *   - Validate every 2xx response body against the schemas in
 *     `@time-off/hcm-port` (TRD §13.2 strict validation).
 *   - Map error responses to the typed {@link HcmError} hierarchy so callers
 *     can route by `instanceof`.
 *   - Report each call's outcome to {@link HcmHealthMonitor}.
 *
 * @ref docs/01_TRD.md §13.2, §17.2
 * @ref docs/04_Module_Plan.md §3.9, §5.1
 */

export interface MockHcmAdapterOptions {
  readonly baseUrl: string;
  /** Per-call timeout in milliseconds. Default: 5000. */
  readonly timeoutMs?: number;
}

const HcmErrorBodySchema = z
  .object({
    error: z.string(),
    message: z.string(),
  })
  .passthrough();

interface RequestContext {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly employeeIdHint?: string;
}

@Injectable()
export class MockHcmAdapter implements HcmPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    options: MockHcmAdapterOptions,
    private readonly health: HcmHealthMonitor,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  fetchBalance(args: FetchBalanceArgs): Promise<HcmFetchBalanceResponse> {
    return this.json(
      { method: 'GET', path: `/balances/${args.employeeId}/${args.locationId}/${args.leaveTypeId}`, employeeIdHint: args.employeeId },
      HcmFetchBalanceResponseSchema,
    );
  }

  fetchEmployment(employeeId: string): Promise<HcmEmploymentResponse> {
    return this.json(
      { method: 'GET', path: `/employment/${employeeId}`, employeeIdHint: employeeId },
      HcmEmploymentResponseSchema,
    );
  }

  fetchLeaveTypes(locationId: string): Promise<HcmLeaveTypesResponse> {
    return this.json(
      { method: 'GET', path: `/leaveTypes/${locationId}` },
      HcmLeaveTypesResponseSchema,
    );
  }

  fetchEmployee(employeeId: string): Promise<HcmEmployeeResponse> {
    return this.json(
      { method: 'GET', path: `/employees/${employeeId}`, employeeIdHint: employeeId },
      HcmEmployeeResponseSchema,
    );
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  reserveBalance(args: ReserveBalanceArgs, idempotencyKey: string): Promise<HcmMutationResponse> {
    return this.json(
      { method: 'POST', path: '/balances/reserve', employeeIdHint: args.employeeId },
      HcmMutationResponseSchema,
      { body: serializeMutationArgs(args), idempotencyKey },
    );
  }

  releaseBalance(args: ReleaseBalanceArgs, idempotencyKey: string): Promise<HcmMutationResponse> {
    return this.json(
      { method: 'POST', path: '/balances/release', employeeIdHint: args.employeeId },
      HcmMutationResponseSchema,
      { body: serializeMutationArgs(args), idempotencyKey },
    );
  }

  // ── Transaction history (TRD §13.2.1) ────────────────────────────────────

  queryTransactions(query: HcmTransactionQuery): Promise<HcmTransactionRecord[]> {
    return this.json(
      { method: 'POST', path: '/transactions/query', employeeIdHint: query.employeeId },
      HcmTransactionHistorySchema,
      { body: serializeTransactionQuery(query) },
    );
  }

  // ── Batch (TRD §10.2, §17.2 NDJSON) ──────────────────────────────────────

  async *fetchBatch(cursor?: string): AsyncIterable<HcmBatchEntry> {
    const path = cursor ? `/balances/batch?cursor=${encodeURIComponent(cursor)}` : '/balances/batch';
    const ctx: RequestContext = { method: 'GET', path };
    const response = await this.fetchWithTimeout(ctx);
    const body = await this.readBody(response, ctx);
    this.requireOk(response, body, ctx);
    this.health.recordSuccess();

    for (const line of body.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new HcmContractViolation(
          `Mock HCM ${ctx.method} ${ctx.path}: NDJSON line is not valid JSON`,
          [],
          err,
        );
      }
      const validation = HcmBatchEntrySchema.safeParse(parsed);
      if (!validation.success) {
        throw new HcmContractViolation(
          `Mock HCM ${ctx.method} ${ctx.path}: batch entry failed schema`,
          validation.error.issues,
        );
      }
      yield validation.data;
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * One-shot helper: issue HTTP, route 5xx/network errors to transient
   * failures, 4xx to typed permanent errors, 2xx through the supplied schema.
   * Reports the outcome to the health monitor exactly once per call.
   *
   * The `S extends z.ZodTypeAny` shape lets us accept zod schemas that
   * transform (string→Decimal, string→bigint) — their input and output types
   * differ, so a plain `z.ZodType<T>` won't fit.
   */
  private async json<S extends z.ZodTypeAny>(
    ctx: RequestContext,
    schema: S,
    opts: { readonly body?: unknown; readonly idempotencyKey?: string } = {},
  ): Promise<z.output<S>> {
    const response = await this.fetchWithTimeout(ctx, opts);
    const body = await this.readBody(response, ctx);
    this.requireOk(response, body, ctx);
    this.health.recordSuccess();
    const validation = schema.safeParse(body === '' ? undefined : safeJsonParse(body, ctx));
    if (!validation.success) {
      throw new HcmContractViolation(
        `Mock HCM ${ctx.method} ${ctx.path}: response failed schema`,
        validation.error.issues,
      );
    }
    return validation.data as z.output<S>;
  }

  private async fetchWithTimeout(
    ctx: RequestContext,
    opts: { readonly body?: unknown; readonly idempotencyKey?: string } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey;
    try {
      return await fetch(`${this.baseUrl}${ctx.path}`, {
        method: ctx.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      this.health.recordFailure('transient');
      const reason = (err as { name?: string }).name === 'AbortError' ? 'timeout' : 'network failure';
      throw new HcmTransientError(`Mock HCM ${ctx.method} ${ctx.path}: ${reason}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(response: Response, ctx: RequestContext): Promise<string> {
    try {
      return await response.text();
    } catch (err) {
      this.health.recordFailure('transient');
      throw new HcmTransientError(`Mock HCM ${ctx.method} ${ctx.path}: failed to read body`, {
        cause: err,
      });
    }
  }

  /**
   * Branch on HTTP status. 5xx → transient. 4xx → typed permanent (or
   * EmployeeNotFound). 2xx falls through to the caller. Throws on non-2xx.
   */
  private requireOk(response: Response, body: string, ctx: RequestContext): void {
    if (response.status < 400) return;

    if (response.status >= 500) {
      this.health.recordFailure('transient');
      throw new HcmTransientError(
        `Mock HCM ${ctx.method} ${ctx.path} → ${response.status}: ${body}`,
      );
    }

    // 4xx: HCM is reachable; the call was rejected on its merits.
    this.health.recordSuccess();
    throw this.mapErrorResponse(response.status, body, ctx);
  }

  private mapErrorResponse(status: number, body: string, ctx: RequestContext): HcmPermanentError {
    const parsed = HcmErrorBodySchema.safeParse(safeJsonParse(body, ctx));
    const { error, message } = parsed.success
      ? parsed.data
      : { error: 'OTHER', message: `Mock HCM ${ctx.method} ${ctx.path} → ${status}: ${body}` };

    if (error === 'EMPLOYEE_NOT_FOUND') {
      return new HcmEmployeeNotFoundError(ctx.employeeIdHint ?? 'unknown', message);
    }
    return new HcmPermanentError(toPermanentReason(error), message);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function serializeMutationArgs(args: ReserveBalanceArgs | ReleaseBalanceArgs): {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly units: string;
} {
  return {
    employeeId: args.employeeId,
    locationId: args.locationId,
    leaveTypeId: args.leaveTypeId,
    units: args.units.toFixed(),
  };
}

function serializeTransactionQuery(query: HcmTransactionQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    employeeId: query.employeeId,
    locationId: query.locationId,
    leaveTypeId: query.leaveTypeId,
  };
  if (query.idempotencyKey !== undefined) body.idempotencyKey = query.idempotencyKey;
  if (query.window !== undefined) body.window = query.window;
  return body;
}

function safeJsonParse(body: string, _ctx: RequestContext): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

const KNOWN_PERMANENT_REASONS: ReadonlySet<HcmPermanentReason> = new Set<HcmPermanentReason>([
  'INSUFFICIENT_BALANCE',
  'INVALID_DIMENSION',
  'IDEMPOTENCY_REPLAY_MISMATCH',
  'AUTH_FAILED',
  'OTHER',
]);

function toPermanentReason(raw: string): HcmPermanentReason {
  return KNOWN_PERMANENT_REASONS.has(raw as HcmPermanentReason)
    ? (raw as HcmPermanentReason)
    : 'OTHER';
}
