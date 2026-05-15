import { Inject, Injectable } from '@nestjs/common';
import {
  HcmContractViolation,
  HcmEmployeeNotFoundError,
  HcmPermanentError,
  HcmTransientError,
  type HcmPort,
} from '@time-off/hcm-port';
import { parseDecimal } from '@time-off/decimal-scalar';
import { BalanceService } from '../../domain/balance/balance.service';
import { HCM_PORT } from '../hcm/hcm-adapter.module';
import { OutboxStore, type OutboxEntry } from './outbox.store';

export interface OutboxWorkerOptions {
  readonly batchSize?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxAttempts?: number;
  /** Stale `IN_FLIGHT` rolled back to `PENDING` if older than this on a tick. */
  readonly inFlightTimeoutMs?: number;
  /** Test seam; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Test seam; defaults to `Math.random`. */
  readonly random?: () => number;
}

export interface TickResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly transient: number;
  readonly permanent: number;
  readonly suspectNoOp: number;
}

/**
 * Drains the outbox in batches: claim → dispatch via {@link HcmPort} →
 * record outcome. Retry math is exponential with jitter, capped at
 * `maxBackoffMs`; exhausting `maxAttempts` flips the entry to
 * `FAILED_RETRYABLE` (terminal until manually intervened).
 *
 * @ref docs/01_TRD.md §5.7, §10.3, §16 (outbox.* config)
 * @ref docs/04_Module_Plan.md §3.13
 */
@Injectable()
export class OutboxWorker {
  private readonly batchSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly inFlightTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly store: OutboxStore,
    private readonly balance: BalanceService,
    @Inject(HCM_PORT) private readonly hcm: HcmPort,
    @Inject('OUTBOX_WORKER_OPTIONS') options: OutboxWorkerOptions,
  ) {
    this.batchSize = options.batchSize ?? 10;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.inFlightTimeoutMs = options.inFlightTimeoutMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * One drain cycle. Idempotent and safe to call from a timer or directly
   * from a test. Returns a per-outcome summary for assertions and metrics.
   */
  async tick(): Promise<TickResult> {
    this.store.recoverStaleInFlight(
      new Date(this.now() - this.inFlightTimeoutMs).toISOString(),
    );

    const claimed = this.store.claim({
      now: new Date(this.now()).toISOString(),
      batchSize: this.batchSize,
    });

    const result = { claimed: claimed.length, succeeded: 0, transient: 0, permanent: 0, suspectNoOp: 0 };

    for (const entry of claimed) {
      try {
        await this.dispatch(entry);
        this.store.markSucceeded(entry.id, this.iso());
        result.succeeded += 1;
      } catch (err) {
        this.applyFailure(entry, err);
        if (err instanceof HcmTransientError) result.transient += 1;
        else if (err instanceof HcmPermanentError) result.permanent += 1;
        else if (err instanceof HcmContractViolation) result.suspectNoOp += 1;
        else result.permanent += 1; // unexpected errors land terminal
      }
    }

    return result;
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  private async dispatch(entry: OutboxEntry): Promise<void> {
    switch (entry.type) {
      case 'RESERVE_BALANCE':
        await this.dispatchMutation(entry, (args, key) => this.hcm.reserveBalance(args, key));
        return;
      case 'RELEASE_BALANCE':
        await this.dispatchMutation(entry, (args, key) => this.hcm.releaseBalance(args, key));
        return;
      case 'FETCH_BALANCE':
        await this.dispatchFetchBalance(entry);
        return;
      case 'BOOTSTRAP_EMPLOYEE':
      case 'RECONCILE_PROVISIONAL':
        // TRD §10.3 reserves these entry types. Neither bootstrap nor the
        // provisional reconciler currently route through the outbox — both
        // call HCM directly via the port. If something enqueues either type,
        // the unhandled dispatch is a programmer error, not a transient
        // failure, so fail permanently rather than retry forever.
        throw new HcmPermanentError(
          'OTHER',
          `outbox dispatch for type ${entry.type} has no producer`,
        );
    }
  }

  private async dispatchMutation(
    entry: OutboxEntry,
    call: (args: {
      employeeId: string;
      locationId: string;
      leaveTypeId: string;
      units: import('decimal.js').default;
    }, idempotencyKey: string) => Promise<{
      transactionId: string;
      deltaApplied: import('decimal.js').default;
      newAvailable: import('decimal.js').default;
      hcmVersion: bigint;
      appliedAt: string;
    }>,
  ): Promise<void> {
    const args = this.parseMutationPayload(entry);
    const response = await call(args, entry.idempotencyKey);
    this.balance.applyHcmUpdate({
      employeeId: args.employeeId,
      locationId: args.locationId,
      leaveTypeId: args.leaveTypeId,
      available: response.newAvailable,
      hcmVersion: response.hcmVersion,
      hcmEffectiveAt: response.appliedAt,
    });
  }

  private async dispatchFetchBalance(entry: OutboxEntry): Promise<void> {
    const args = this.parseDimensionsPayload(entry);
    const response = await this.hcm.fetchBalance(args);
    this.balance.applyHcmUpdate({
      employeeId: response.employeeId,
      locationId: response.locationId,
      leaveTypeId: response.leaveTypeId,
      available: response.available,
      hcmVersion: response.hcmVersion,
      hcmEffectiveAt: response.appliedAt,
    });
  }

  // ── outcome handling ─────────────────────────────────────────────────────

  private applyFailure(entry: OutboxEntry, err: unknown): void {
    const at = this.iso();
    if (err instanceof HcmEmployeeNotFoundError || err instanceof HcmPermanentError) {
      this.store.markPermanentFailure(entry.id, serializeError(err), at);
      return;
    }
    if (err instanceof HcmContractViolation) {
      this.store.markSuspectNoOp(entry.id, serializeError(err), at);
      return;
    }
    if (err instanceof HcmTransientError) {
      const nextState = entry.attempts >= this.maxAttempts ? 'FAILED_RETRYABLE' : 'PENDING';
      const backoffMs =
        nextState === 'PENDING' ? this.backoffMs(entry.attempts, err.retryAfterMs) : 0;
      this.store.markRetryableFailure({
        id: entry.id,
        error: serializeError(err),
        nextAttemptAt: new Date(this.now() + backoffMs).toISOString(),
        at,
        nextState,
      });
      return;
    }
    // Unexpected — surface as permanent so it stops the retry loop.
    this.store.markPermanentFailure(entry.id, `unexpected: ${serializeError(err)}`, at);
  }

  private backoffMs(attempts: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, this.maxBackoffMs);
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempts);
    const jitter = exp * 0.25 * this.random();
    return Math.min(this.maxBackoffMs, exp + jitter);
  }

  // ── payload parsing (zod would be heavier than what we need here) ────────

  private parseMutationPayload(entry: OutboxEntry): {
    employeeId: string;
    locationId: string;
    leaveTypeId: string;
    units: import('decimal.js').default;
  } {
    const dims = this.parseDimensionsPayload(entry);
    const units = entry.payload.units;
    if (typeof units !== 'string') {
      throw new HcmContractViolation(
        `outbox payload for ${entry.id}: 'units' must be a decimal string`,
        [],
      );
    }
    return { ...dims, units: parseDecimal(units) };
  }

  private parseDimensionsPayload(entry: OutboxEntry): {
    employeeId: string;
    locationId: string;
    leaveTypeId: string;
  } {
    const p = entry.payload;
    if (
      typeof p.employeeId !== 'string' ||
      typeof p.locationId !== 'string' ||
      typeof p.leaveTypeId !== 'string'
    ) {
      throw new HcmContractViolation(
        `outbox payload for ${entry.id}: missing dimensions (employeeId / locationId / leaveTypeId)`,
        [],
      );
    }
    return { employeeId: p.employeeId, locationId: p.locationId, leaveTypeId: p.leaveTypeId };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
