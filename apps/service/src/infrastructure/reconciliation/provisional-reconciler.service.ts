import { Inject, Injectable } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  HcmEmployeeNotFoundError,
  HcmPermanentError,
  HcmTransientError,
  type HcmMutationResponse,
  type HcmPort,
  type HcmTransactionRecord,
  type ReleaseBalanceArgs,
  type ReserveBalanceArgs,
} from '@time-off/hcm-port';
import Decimal from 'decimal.js';
import { BalanceService } from '../../domain/balance/balance.service';
import {
  ProvisionalActionStore,
  type ProvisionalActionRow,
} from '../../domain/provisional-action/provisional-action.store';
import { RequestStore } from '../../domain/request/request.store';
import { HCM_PORT } from '../hcm/hcm-adapter.module';
import { AuditEventService } from '../observability/audit-event.service';
import { METRICS, type Metrics } from '../observability/metrics';
import { DATABASE } from '../persistence/database.token';
import {
  ReconciliationStepStore,
  type ReconciliationStepKind,
} from './reconciliation-step.store';
import { ReconcilerLeaseStore } from './reconciler-lease.store';

/**
 * Configurable knobs (TRD §16, mirrored from `breakGlass.*` / `reconciler.*`).
 */
export interface ProvisionalReconcilerOptions {
  /** Pre-flight history-query window. Default 24h (Rev 3.1, Q.κ). */
  readonly historyQueryWindowMs?: number;
  /** A `ProvisionalAction` PENDING longer than this is "stale" (TRD §9.5.6). */
  readonly staleAfterMs?: number;
  /** How long an acquired lease lives before it can be reclaimed. */
  readonly leaseTtlMs?: number;
  /** Identifies this worker in the lease + step log. Default: random per process. */
  readonly workerId?: string;
  /** Test seam. */
  readonly now?: () => number;
}

export interface ReconcilerTickResult {
  readonly inspected: number;
  readonly confirmed: number;
  readonly escalated: number;
  readonly noOps: number;
  readonly retryable: number;
  readonly staleAlertsEmitted: number;
  readonly skippedLeaseHeld: boolean;
}

const HISTORY_WINDOW_MS_DEFAULT = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS_DEFAULT = 4 * 60 * 60 * 1000;
const LEASE_TTL_MS_DEFAULT = 5 * 60 * 1000;

/**
 * Drains pending {@link ProvisionalActionRow} rows back to HCM on recovery
 * (TRD §9.5.3). Subscribes to `HcmHealthMonitor` transitions to fire ticks
 * eagerly; the surrounding host scheduler also calls `tick()` on a cadence.
 *
 * The algorithm in {@link drain} is the formalized one from TRD §9.5.3 with
 * three properties this code preserves:
 *
 *   1. **Mutual exclusion** — `reconciler_lease` advisory lock per tick.
 *   2. **Restart safety** — every observable side-effect is preceded by a
 *      `reconciliation_step` insert; a crash leaves enough evidence to
 *      resume without double-applying at HCM.
 *   3. **Exactly-once at HCM** — pre-flight `queryTransactions` keyed on the
 *      `ProvisionalAction.id` short-circuits when HCM already has the txn.
 *
 * @ref docs/01_TRD.md §9.5.3, §9.5.5, §9.5.6
 * @ref docs/04_Module_Plan.md §3.16
 */
@Injectable()
export class ProvisionalReconciler {
  private readonly historyQueryWindowMs: number;
  private readonly staleAfterMs: number;
  private readonly leaseTtlMs: number;
  private readonly workerId: string;
  private readonly now: () => number;

  constructor(
    private readonly lease: ReconcilerLeaseStore,
    private readonly actions: ProvisionalActionStore,
    private readonly steps: ReconciliationStepStore,
    private readonly requests: RequestStore,
    private readonly balance: BalanceService,
    private readonly audit: AuditEventService,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(HCM_PORT) private readonly hcm: HcmPort,
    @Inject(DATABASE) private readonly db: Database,
    @Inject('PROVISIONAL_RECONCILER_OPTIONS')
    options: ProvisionalReconcilerOptions,
  ) {
    this.historyQueryWindowMs = options.historyQueryWindowMs ?? HISTORY_WINDOW_MS_DEFAULT;
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS_DEFAULT;
    this.leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS_DEFAULT;
    this.workerId = options.workerId ?? `provisional-reconciler-${randomUUID()}`;
    this.now = options.now ?? Date.now;
  }

  /**
   * Single drain pass. Safe to call concurrently — second caller skips when
   * the lease is held. Returns counts per outcome so the host can log/meter.
   */
  async tick(): Promise<ReconcilerTickResult> {
    const acquiredAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + this.leaseTtlMs).toISOString();
    const got = this.lease.acquire({
      id: 'provisional',
      holder: this.workerId,
      at: acquiredAt,
      expiresAt,
    });
    if (!got) {
      return {
        inspected: 0,
        confirmed: 0,
        escalated: 0,
        noOps: 0,
        retryable: 0,
        staleAlertsEmitted: 0,
        skippedLeaseHeld: true,
      };
    }

    try {
      const pending = this.actions.listPending();
      const coalesced = this.coalescePairs(pending);
      const remaining = pending.filter((a) => !coalesced.has(a.id));
      const staleAlertsEmitted = this.emitStaleAlerts(remaining);

      let confirmed = 0;
      let escalated = 0;
      let noOps = coalesced.size;
      let retryable = 0;
      for (const action of remaining) {
        const outcome = await this.reconcile(action);
        switch (outcome) {
          case 'CONFIRMED':
            confirmed += 1;
            break;
          case 'REJECTED_ESCALATED':
            escalated += 1;
            break;
          case 'NO_OP':
            noOps += 1;
            break;
          case 'RETRYABLE':
            retryable += 1;
            break;
        }
      }
      const summary = {
        inspected: pending.length,
        confirmed,
        escalated,
        noOps,
        retryable,
        staleAlertsEmitted,
        skippedLeaseHeld: false,
      };
      if (summary.inspected > 0) {
        this.audit.emit({
          action: 'PROVISIONAL_RECONCILIATION_PASS_COMPLETED',
          entityType: 'Reconciler',
          entityId: this.workerId,
          actor: this.workerId,
          after: summary,
        });
      }
      this.metrics.counter('reconciler.provisional_tick_completed', 1, {
        confirmed: String(confirmed),
        escalated: String(escalated),
      });
      return summary;
    } finally {
      this.lease.release('provisional', this.workerId);
    }
  }

  // ── Pair coalescing (TRD §9.5.3 step [1], Q.ζ) ────────────────────────────

  /**
   * For each `requestId` with both a `BREAK_GLASS_APPROVAL` and a
   * `PROVISIONAL_CANCELLATION` pending: mark both `NO_OP` in one TX and skip
   * any HCM calls. Returns the set of action IDs that were coalesced.
   */
  private coalescePairs(pending: readonly ProvisionalActionRow[]): Set<string> {
    const byRequest = new Map<string, ProvisionalActionRow[]>();
    for (const action of pending) {
      const list = byRequest.get(action.requestId);
      if (list) list.push(action);
      else byRequest.set(action.requestId, [action]);
    }

    const coalesced = new Set<string>();
    for (const [, group] of byRequest) {
      const approval = group.find((a) => a.type === 'BREAK_GLASS_APPROVAL');
      const cancellation = group.find((a) => a.type === 'PROVISIONAL_CANCELLATION');
      if (!approval || !cancellation) continue;

      this.db.transaction(() => {
        for (const action of [approval, cancellation]) {
          this.markActionReconciled(action.id, 'NO_OP', {
            reason: 'PAIR_COALESCED',
            pairedWith: action === approval ? cancellation.id : approval.id,
          });
          this.steps.append({
            id: randomUUID(),
            actionId: action.id,
            kind: 'PAIR_COALESCED',
            outcome: 'TERMINAL',
            payload: { pairedWith: action === approval ? cancellation.id : approval.id },
            occurredAt: new Date(this.now()).toISOString(),
            workerId: this.workerId,
          });
        }
        // Coalesced pair: the request never actually debited HCM, so release
        // the provisional hold and terminate at CANCELLED. After
        // `cancelProvisionally` the state is `CANCELLATION_PENDING`; if the
        // user never called it the state is still `PROVISIONALLY_APPROVED` —
        // both transition to CANCELLED.
        const request = this.requests.find(approval.requestId);
        if (
          request &&
          (request.state === 'PROVISIONALLY_APPROVED' ||
            request.state === 'CANCELLATION_PENDING')
        ) {
          this.balance.releaseHold(
            request.employeeId,
            request.locationId,
            request.leaveTypeId,
            request.units,
            'provisional',
          );
          this.requests.markCancelled({
            id: request.id,
            at: new Date(this.now()).toISOString(),
          });
        }
      })();

      coalesced.add(approval.id);
      coalesced.add(cancellation.id);

      this.audit.emit({
        action: 'PROVISIONAL_PAIR_COALESCED',
        entityType: 'ProvisionalAction',
        entityId: approval.id,
        actor: this.workerId,
        after: {
          requestId: approval.requestId,
          approvalId: approval.id,
          cancellationId: cancellation.id,
          finalState: 'CANCELLED',
        },
      });
    }
    return coalesced;
  }

  // ── Per-action reconciliation (TRD §9.5.3 step [3]) ──────────────────────

  private async reconcile(
    action: ProvisionalActionRow,
  ): Promise<'CONFIRMED' | 'REJECTED_ESCALATED' | 'NO_OP' | 'RETRYABLE'> {
    // [3.0] Skip if a TERMINAL step already exists for this action.
    const last = this.steps.findLast(action.id);
    if (last && last.outcome === 'TERMINAL') return 'NO_OP';

    const request = this.requests.find(action.requestId);
    if (!request) {
      this.markActionReconciled(action.id, 'NO_OP', { reason: 'REQUEST_NOT_FOUND' });
      this.appendTerminal(action.id, { reason: 'REQUEST_NOT_FOUND' });
      return 'NO_OP';
    }

    // [3.1] PRE-FLIGHT history query.
    let history: HcmTransactionRecord[];
    try {
      const windowStart = new Date(
        new Date(action.invokedAt).getTime() - this.historyQueryWindowMs,
      ).toISOString();
      const windowEnd = new Date(this.now()).toISOString();
      history = await this.hcm.queryTransactions({
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveTypeId: request.leaveTypeId,
        idempotencyKey: action.id,
        window: { start: windowStart, end: windowEnd },
      });
      this.steps.append({
        id: randomUUID(),
        actionId: action.id,
        kind: 'HCM_HISTORY_QUERIED',
        outcome: 'PARTIAL',
        payload: { matchCount: history.length },
        occurredAt: new Date(this.now()).toISOString(),
        workerId: this.workerId,
      });
    } catch (err) {
      if (err instanceof HcmEmployeeNotFoundError) {
        return this.handleEmployeeDeleted(action, request.id, 'HISTORY_QUERY');
      }
      if (err instanceof HcmTransientError) {
        this.steps.append({
          id: randomUUID(),
          actionId: action.id,
          kind: 'HCM_HISTORY_QUERY_FAILED',
          outcome: 'PARTIAL',
          payload: { message: err.message },
          occurredAt: new Date(this.now()).toISOString(),
          workerId: this.workerId,
        });
        return 'RETRYABLE';
      }
      throw err;
    }

    const existing = history.find((r) => r.idempotencyKey === action.id);

    // [3.1b] Mismatched delta → escalate.
    if (existing && !this.deltaMatches(existing, request.units, action.type)) {
      this.steps.append({
        id: randomUUID(),
        actionId: action.id,
        kind: 'HISTORY_MISMATCH',
        outcome: 'TERMINAL',
        payload: {
          expectedDelta: this.expectedDelta(request.units, action.type).toFixed(),
          actualDelta: existing.deltaApplied.toFixed(),
          hcmTransactionId: existing.transactionId,
        },
        occurredAt: new Date(this.now()).toISOString(),
        workerId: this.workerId,
      });
      this.applyEscalation(action, request.id, {
        reason: 'HCM transaction exists with mismatched delta — manual review',
        kind: 'HISTORY_MISMATCH',
        hcmTransactionId: existing.transactionId,
      });
      return 'REJECTED_ESCALATED';
    }

    // [3.1a] Existing matching txn → treat as already applied; apply outcome.
    // [3.1c] No existing txn → call HCM now.
    let response: HcmMutationResponse;
    if (existing) {
      response = {
        transactionId: existing.transactionId,
        deltaApplied: existing.deltaApplied,
        // We don't know newAvailable from a history record — leave Balance
        // refresh to the next batch/point-read. Mark with the version we do
        // know so applyOutcome can still set hcmVersion.
        newAvailable: this.balance.get(
          request.employeeId,
          request.locationId,
          request.leaveTypeId,
        )?.available ?? new Decimal(0),
        hcmVersion: existing.hcmVersion,
        appliedAt: existing.appliedAt,
      };
    } else {
      try {
        response = await this.callHcm(action, request);
      } catch (err) {
        if (err instanceof HcmEmployeeNotFoundError) {
          return this.handleEmployeeDeleted(action, request.id, 'MUTATION');
        }
        if (err instanceof HcmTransientError) {
          return 'RETRYABLE';
        }
        if (err instanceof HcmPermanentError && err.reason === 'INSUFFICIENT_BALANCE') {
          return this.handleHcmRejection(action, request);
        }
        throw err;
      }
    }

    this.applyAcceptedOutcome(action, request, response);
    return 'CONFIRMED';
  }

  // ── HCM call dispatch ────────────────────────────────────────────────────

  private async callHcm(
    action: ProvisionalActionRow,
    request: { employeeId: string; locationId: string; leaveTypeId: string; units: Decimal },
  ): Promise<HcmMutationResponse> {
    this.steps.append({
      id: randomUUID(),
      actionId: action.id,
      kind: 'HCM_CALL_IN_FLIGHT',
      outcome: 'PARTIAL',
      payload: { actionType: action.type },
      occurredAt: new Date(this.now()).toISOString(),
      workerId: this.workerId,
    });
    const args: ReserveBalanceArgs | ReleaseBalanceArgs = {
      employeeId: request.employeeId,
      locationId: request.locationId,
      leaveTypeId: request.leaveTypeId,
      units: request.units,
    };
    if (action.type === 'BREAK_GLASS_APPROVAL') {
      return this.hcm.reserveBalance(args, action.id);
    }
    return this.hcm.releaseBalance(args, action.id);
  }

  // ── Outcome application (TRD §9.5.3 step [3.3]) ──────────────────────────

  private applyAcceptedOutcome(
    action: ProvisionalActionRow,
    request: NonNullable<ReturnType<RequestStore['find']>>,
    response: HcmMutationResponse,
  ): void {
    const now = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      this.steps.append({
        id: randomUUID(),
        actionId: action.id,
        kind: 'OUTCOME_APPLIED',
        outcome: 'TERMINAL',
        payload: {
          hcmTransactionId: response.transactionId,
          deltaApplied: response.deltaApplied.toFixed(),
          hcmVersion: response.hcmVersion.toString(),
        },
        occurredAt: now,
        workerId: this.workerId,
      });
      // Update the local balance from HCM's authoritative view. The
      // provisional hold is released only for BREAK_GLASS_APPROVAL — the
      // cancellation saga doesn't move holds, so there's nothing to release.
      this.balance.applyHcmUpdate({
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveTypeId: request.leaveTypeId,
        available: response.newAvailable,
        hcmVersion: response.hcmVersion,
        hcmEffectiveAt: response.appliedAt,
      });
      if (action.type === 'BREAK_GLASS_APPROVAL') {
        this.balance.releaseHold(
          request.employeeId,
          request.locationId,
          request.leaveTypeId,
          request.units,
          'provisional',
        );
      }
      // Request transitions: APPROVED unless its endDate has passed (TRD §9.5.5).
      if (action.type === 'BREAK_GLASS_APPROVAL') {
        if (this.endDatePassed(request.endDate)) {
          this.requests.markTaken({
            id: request.id,
            hrReviewFlag: false,
            hrReviewReason: null,
            at: now,
          });
        } else {
          this.requests.markApprovedFromProvisional({
            id: request.id,
            hcmTransactionId: response.transactionId,
            at: now,
          });
        }
      } else {
        // PROVISIONAL_CANCELLATION confirmed
        this.requests.markCancelled({ id: request.id, at: now });
      }
      this.markActionReconciled(action.id, 'CONFIRMED', {
        hcmTransactionId: response.transactionId,
        deltaApplied: response.deltaApplied.toFixed(),
      });
    })();
    this.audit.emit({
      action:
        action.type === 'BREAK_GLASS_APPROVAL'
          ? 'PROVISIONAL_APPROVAL_CONFIRMED'
          : 'PROVISIONAL_CANCELLATION_CONFIRMED',
      entityType: 'ProvisionalAction',
      entityId: action.id,
      actor: this.workerId,
      after: {
        requestId: request.id,
        hcmTransactionId: response.transactionId,
        deltaApplied: response.deltaApplied.toFixed(),
      },
    });
  }

  private handleHcmRejection(
    action: ProvisionalActionRow,
    request: NonNullable<ReturnType<RequestStore['find']>>,
  ): 'REJECTED_ESCALATED' {
    const reason =
      action.type === 'BREAK_GLASS_APPROVAL'
        ? 'HCM rejected provisional approval'
        : 'HCM rejected provisional cancellation';
    if (action.type === 'BREAK_GLASS_APPROVAL' && this.endDatePassed(request.endDate)) {
      // §9.5.5: leave already taken — terminal TAKEN with HR flag.
      this.db.transaction(() => {
        this.steps.append({
          id: randomUUID(),
          actionId: action.id,
          kind: 'OUTCOME_APPLIED',
          outcome: 'TERMINAL',
          payload: { hcmRejected: true, leaveAlreadyTaken: true },
          occurredAt: new Date(this.now()).toISOString(),
          workerId: this.workerId,
        });
        this.balance.releaseHold(
          request.employeeId,
          request.locationId,
          request.leaveTypeId,
          request.units,
          'provisional',
        );
        this.requests.markTaken({
          id: request.id,
          hrReviewFlag: true,
          hrReviewReason:
            'Leave was taken under provisional approval; HCM rejected reconciliation. HR must determine resolution.',
          at: new Date(this.now()).toISOString(),
        });
        this.markActionReconciled(action.id, 'REJECTED_ESCALATED', {
          reason,
          leaveAlreadyTaken: true,
        });
      })();
      this.audit.emit({
        action: 'PROVISIONAL_APPROVAL_ESCALATED',
        entityType: 'ProvisionalAction',
        entityId: action.id,
        actor: this.workerId,
        after: {
          requestId: request.id,
          reason,
          finalState: 'TAKEN',
          hrReviewFlag: true,
        },
      });
      return 'REJECTED_ESCALATED';
    }
    this.applyEscalation(action, request.id, { reason, kind: 'HCM_REJECTED' });
    return 'REJECTED_ESCALATED';
  }

  private handleEmployeeDeleted(
    action: ProvisionalActionRow,
    requestId: string,
    phase: 'HISTORY_QUERY' | 'MUTATION',
  ): 'REJECTED_ESCALATED' {
    this.db.transaction(() => {
      this.steps.append({
        id: randomUUID(),
        actionId: action.id,
        kind: 'EMPLOYEE_NOT_FOUND_AT_HCM',
        outcome: 'TERMINAL',
        payload: { phase },
        occurredAt: new Date(this.now()).toISOString(),
        workerId: this.workerId,
      });
      this.requests.markEscalatedToHr({
        id: requestId,
        reason: 'Employee no longer exists in HCM',
        at: new Date(this.now()).toISOString(),
      });
      this.markActionReconciled(action.id, 'REJECTED_ESCALATED', {
        kind: 'EMPLOYEE_DELETED',
        phase,
      });
    })();
    this.audit.emit({
      action: 'PROVISIONAL_APPROVAL_ESCALATED',
      entityType: 'ProvisionalAction',
      entityId: action.id,
      actor: this.workerId,
      after: {
        requestId,
        kind: 'EMPLOYEE_DELETED',
        reason: 'Employee no longer exists in HCM',
        phase,
      },
    });
    return 'REJECTED_ESCALATED';
  }

  private applyEscalation(
    action: ProvisionalActionRow,
    requestId: string,
    details: { reason: string; kind: string; hcmTransactionId?: string },
  ): void {
    const at = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      this.requests.markEscalatedToHr({ id: requestId, reason: details.reason, at });
      // Only BREAK_GLASS_APPROVAL puts units in the provisional bucket. A
      // cancellation escalation leaves the original HCM debit in place;
      // nothing to release locally.
      if (action.type === 'BREAK_GLASS_APPROVAL') {
        const request = this.requests.find(requestId);
        if (request) {
          this.balance.releaseHold(
            request.employeeId,
            request.locationId,
            request.leaveTypeId,
            request.units,
            'provisional',
          );
        }
      }
      this.markActionReconciled(action.id, 'REJECTED_ESCALATED', details);
    })();
    this.audit.emit({
      action: 'PROVISIONAL_APPROVAL_ESCALATED',
      entityType: 'ProvisionalAction',
      entityId: action.id,
      actor: this.workerId,
      after: { requestId, ...details },
    });
  }

  // ── Stale alerts (TRD §9.5.6) ────────────────────────────────────────────

  private emitStaleAlerts(actions: readonly ProvisionalActionRow[]): number {
    const cutoff = this.now() - this.staleAfterMs;
    let emitted = 0;
    let stillStale = 0;
    for (const action of actions) {
      const ageMs = this.now() - new Date(action.invokedAt).getTime();
      if (ageMs < this.staleAfterMs) continue;
      stillStale += 1;
      const lastAlerted = action.lastStaleAlertAt
        ? new Date(action.lastStaleAlertAt).getTime()
        : null;
      // dedup: only emit if no prior alert within this tick window
      if (lastAlerted !== null && lastAlerted > cutoff) continue;
      this.actions.recordStaleAlert(action.id, new Date(this.now()).toISOString());
      this.audit.emit({
        action: 'PROVISIONAL_ACTION_STALE',
        entityType: 'ProvisionalAction',
        entityId: action.id,
        actor: this.workerId,
        after: {
          requestId: action.requestId,
          ageMs,
          bucket: staleAgeBucket(ageMs),
        },
      });
      emitted += 1;
    }
    // Gauge reflects the *current* stale count, not a delta — drains naturally
    // when the reconciler clears actions (TRD §9.5.6).
    this.metrics.gauge('reconciler.provisional_action_stale_count', stillStale);
    return emitted;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private markActionReconciled(
    id: string,
    state: 'CONFIRMED' | 'REJECTED_ESCALATED' | 'NO_OP',
    details: Readonly<Record<string, unknown>>,
  ): void {
    this.actions.markReconciled({
      id,
      reconciliationState: state,
      reconciledAt: new Date(this.now()).toISOString(),
      reconciliationDetails: details,
      snapshotSummary: this.summarizeSnapshotForOutcome(state, details),
      nullifySnapshot: state !== 'REJECTED_ESCALATED',
    });
  }

  private summarizeSnapshotForOutcome(
    state: 'CONFIRMED' | 'REJECTED_ESCALATED' | 'NO_OP',
    details: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    return { outcome: state, ...details };
  }

  private appendTerminal(
    actionId: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.steps.append({
      id: randomUUID(),
      actionId,
      kind: 'TERMINAL' as ReconciliationStepKind,
      outcome: 'TERMINAL',
      payload,
      occurredAt: new Date(this.now()).toISOString(),
      workerId: this.workerId,
    });
  }

  private expectedDelta(units: Decimal, type: ProvisionalActionRow['type']): Decimal {
    return type === 'BREAK_GLASS_APPROVAL' ? units.neg() : units;
  }

  private deltaMatches(
    record: HcmTransactionRecord,
    units: Decimal,
    type: ProvisionalActionRow['type'],
  ): boolean {
    return record.deltaApplied.equals(this.expectedDelta(units, type));
  }

  private endDatePassed(endDateIso: string): boolean {
    const endMidnight = new Date(`${endDateIso}T23:59:59.999Z`).getTime();
    return this.now() > endMidnight;
  }
}

const HOUR_MS = 60 * 60 * 1000;

/** Bucket label used as a metric tag for the stale-action gauge (TRD §9.5.6). */
function staleAgeBucket(ageMs: number): string {
  if (ageMs < HOUR_MS) return '<1h';
  if (ageMs < 4 * HOUR_MS) return '1-4h';
  if (ageMs < 12 * HOUR_MS) return '4-12h';
  return '>12h';
}
