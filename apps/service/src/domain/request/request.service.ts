import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { DomainError } from '@time-off/domain-types';
import {
  HcmEmployeeNotFoundError,
  HcmPermanentError,
  HcmTransientError,
  type HcmPort,
} from '@time-off/hcm-port';
import {
  CanonicalInputSerializer,
  fk,
  parseDecimal,
  type FieldKind,
} from '@time-off/decimal-scalar';
import Decimal from 'decimal.js';
import { HCM_PORT } from '../../infrastructure/hcm/hcm-adapter.module';
import { HcmHealthMonitor } from '../../infrastructure/hcm/hcm-health.monitor';
import { AuditEventService } from '../../infrastructure/observability/audit-event.service';
import { DATABASE } from '../../infrastructure/persistence/database.token';
import { BalanceService } from '../balance/balance.service';
import {
  BreakGlassAuthorizer,
  type ActorRole,
} from '../break-glass/break-glass.authorizer';
import { EmployeeBootstrapService } from '../employee-bootstrap/employee-bootstrap.service';
import { EmploymentService } from '../employment/employment.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { LeaveTypeAvailabilityService } from '../leave-type-availability/leave-type-availability.service';
import { ProvisionalActionStore } from '../provisional-action/provisional-action.store';
import { RequestStateMachine } from './request-state-machine';
import { RequestStore, type TimeOffRequestRow } from './request.store';

/** Caller-supplied envelope tagged onto every mutation for audit + role checks. */
export interface ActorContext {
  readonly actorId: string;
  readonly actorRole: ActorRole;
  readonly correlationId: string;
}

export interface CreateTimeOffRequestInput {
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly units: Decimal | string;
}

interface CachedResponse {
  readonly requestId: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Canonicalization specs (idempotency hashing) ───────────────────────────

const CREATE_SPEC: FieldKind = fk.object({
  employeeId: fk.string,
  leaveTypeId: fk.string,
  startDate: fk.date,
  endDate: fk.date,
  units: fk.decimal(2),
});

const APPROVE_SPEC: FieldKind = fk.object({
  requestId: fk.string,
  approverId: fk.string,
});

const REJECT_SPEC: FieldKind = fk.object({
  requestId: fk.string,
  approverId: fk.string,
  reason: fk.string,
});

const CANCEL_SPEC: FieldKind = fk.object({
  requestId: fk.string,
  actorId: fk.string,
});

const APPROVE_PROVISIONALLY_SPEC: FieldKind = fk.object({
  requestId: fk.string,
  approverId: fk.string,
  justification: fk.string,
});

const CANCEL_PROVISIONALLY_SPEC: FieldKind = fk.object({
  requestId: fk.string,
  actorId: fk.string,
  acknowledgedHcmUnavailable: fk.string,
});

/**
 * The request lifecycle saga.
 *
 *  - `create` / `approve` / `reject` / `cancel`           (TRD §9.1–§9.4)
 *  - `approveProvisionally` (break-glass)                 (TRD §9.5.1–§9.5.2)
 *  - `cancelProvisionally` (provisional cancellation)     (TRD §9.5.4)
 *
 * Every mutation has the same shape:
 *  1. Compute a canonical hash of the inputs and look up the idempotency
 *     cache — `replay` returns the prior result, `conflict` raises
 *     `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`.
 *  2. Validate inputs and resolve dimensions (employment, leave type, role).
 *  3. Call HCM when the operation is dispositive (`approve`, `cancel`
 *     of an `APPROVED` request); on outage, route through the provisional
 *     path which defers the HCM call to the reconciler.
 *  4. Atomically (single SQLite transaction) update the request row, the
 *     balance buckets, the provisional-action log (if applicable), and
 *     stamp the idempotency cache.
 *
 * @ref docs/01_TRD.md §9.1–§9.5, §14.1
 * @ref docs/04_Module_Plan.md §3.2
 */
@Injectable()
export class RequestService {
  private readonly serializer = new CanonicalInputSerializer();

  constructor(
    private readonly store: RequestStore,
    private readonly employment: EmploymentService,
    private readonly leaveTypes: LeaveTypeAvailabilityService,
    private readonly bootstrap: EmployeeBootstrapService,
    private readonly balance: BalanceService,
    private readonly idempotency: IdempotencyService,
    private readonly breakGlass: BreakGlassAuthorizer,
    private readonly provisionalActions: ProvisionalActionStore,
    private readonly health: HcmHealthMonitor,
    private readonly audit: AuditEventService,
    @Inject(HCM_PORT) private readonly hcm: HcmPort,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  // ── create (TRD §9.1) ────────────────────────────────────────────────────

  async create(
    input: CreateTimeOffRequestInput,
    ctx: ActorContext,
    idempotencyKey: string,
  ): Promise<TimeOffRequestRow> {
    const units = this.parseAndValidateInput(input);
    const inputHash = this.serializer.hash(
      { ...input, units: units.toFixed() },
      CREATE_SPEC,
    );

    const replay = this.checkReplay(idempotencyKey, inputHash);
    if (replay) return replay;

    await this.bootstrap.ensureBootstrapped(input.employeeId);

    const startLocation = this.employment.locationAt(input.employeeId, input.startDate);
    if (startLocation === null) {
      throw new DomainError({ code: 'EMPLOYMENT_NOT_FOUND' });
    }
    const endLocation = this.employment.locationAt(input.employeeId, input.endDate);
    if (endLocation !== startLocation) {
      throw new DomainError({
        code: 'REQUEST_SPANS_LOCATION_TRANSFER',
        details: { startLocation, endLocation },
      });
    }
    if (!this.leaveTypes.isActive(startLocation, input.leaveTypeId, input.startDate)) {
      throw new DomainError({ code: 'LEAVE_TYPE_NOT_AVAILABLE' });
    }

    await this.ensureBalanceLoaded(input.employeeId, startLocation, input.leaveTypeId);

    const id = randomUUID();
    const at = new Date().toISOString();
    this.db.transaction(() => {
      this.store.insertPending({
        id,
        idempotencyKey,
        inputHash,
        employeeId: input.employeeId,
        locationId: startLocation,
        leaveTypeId: input.leaveTypeId,
        startDate: input.startDate,
        endDate: input.endDate,
        units,
        at,
      });
      this.balance.applyHold(input.employeeId, startLocation, input.leaveTypeId, units, 'pending');
      this.idempotency.remember(idempotencyKey, inputHash, { requestId: id });
    })();

    this.audit.emit({
      action: 'REQUEST_CREATED',
      entityType: 'TimeOffRequest',
      entityId: id,
      actor: ctx.actorId,
      correlationId: ctx.correlationId,
      after: {
        state: 'PENDING_APPROVAL',
        employeeId: input.employeeId,
        locationId: startLocation,
        leaveTypeId: input.leaveTypeId,
        units: units.toFixed(),
      },
    });
    return this.mustFind(id);
  }

  // ── approve (TRD §9.2) ───────────────────────────────────────────────────

  async approve(
    requestId: string,
    ctx: ActorContext,
    idempotencyKey: string,
  ): Promise<TimeOffRequestRow> {
    const inputHash = this.serializer.hash(
      { requestId, approverId: ctx.actorId },
      APPROVE_SPEC,
    );
    const replay = this.checkReplay(idempotencyKey, inputHash);
    if (replay) return replay;

    const request = this.requireRequest(requestId);
    if (ctx.actorId === request.employeeId) {
      throw new DomainError({
        code: 'STATE_TRANSITION_NOT_ALLOWED',
        message: 'self-approval is prohibited',
      });
    }
    RequestStateMachine.assertTransition(request.state, 'APPROVED');

    let hcmResponse;
    try {
      hcmResponse = await this.hcm.reserveBalance(
        {
          employeeId: request.employeeId,
          locationId: request.locationId,
          leaveTypeId: request.leaveTypeId,
          units: request.units,
        },
        idempotencyKey,
      );
    } catch (err) {
      if (err instanceof HcmTransientError) {
        throw new DomainError({ code: 'HCM_UNAVAILABLE' });
      }
      if (err instanceof HcmEmployeeNotFoundError) {
        throw new DomainError({ code: 'EMPLOYEE_NOT_BOOTSTRAPPED' });
      }
      if (err instanceof HcmPermanentError && err.reason === 'INSUFFICIENT_BALANCE') {
        this.db.transaction(() => {
          this.balance.releaseHold(
            request.employeeId,
            request.locationId,
            request.leaveTypeId,
            request.units,
            'pending',
          );
          this.store.markRejected({
            id: requestId,
            reason: 'INSUFFICIENT_BALANCE_HCM',
            at: new Date().toISOString(),
          });
          this.idempotency.remember(idempotencyKey, inputHash, { requestId });
        })();
        throw new DomainError({ code: 'INSUFFICIENT_BALANCE_HCM' });
      }
      throw err;
    }

    const at = new Date().toISOString();
    this.db.transaction(() => {
      this.balance.releaseHold(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
        request.units,
        'pending',
      );
      this.balance.applyHcmUpdate({
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveTypeId: request.leaveTypeId,
        available: hcmResponse.newAvailable,
        hcmVersion: hcmResponse.hcmVersion,
        hcmEffectiveAt: hcmResponse.appliedAt,
      });
      this.store.markApproved({
        id: requestId,
        approverId: ctx.actorId,
        hcmTransactionId: hcmResponse.transactionId,
        at,
      });
      this.idempotency.remember(idempotencyKey, inputHash, { requestId });
    })();

    this.audit.emit({
      action: 'REQUEST_APPROVED',
      entityType: 'TimeOffRequest',
      entityId: requestId,
      actor: ctx.actorId,
      correlationId: ctx.correlationId,
      before: { state: request.state },
      after: { state: 'APPROVED', hcmTransactionId: hcmResponse.transactionId },
    });
    return this.mustFind(requestId);
  }

  // ── approveProvisionally (TRD §9.5.2) ────────────────────────────────────

  /**
   * Break-glass approval during sustained HCM outage. The decision is
   * recorded as an append-only `ProvisionalAction` event; the request flips
   * to `PROVISIONALLY_APPROVED` and the pending hold is promoted to the
   * `provisional` bucket. The provisional reconciler (Slice 16) drains the
   * event back to HCM on recovery.
   *
   * @throws DomainError(BREAK_GLASS_NOT_AUTHORIZED) when the caller lacks role.
   * @throws DomainError(BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET) when HCM is
   *   healthy or the outage is shorter than `minOutageMs`.
   * @throws DomainError(STATE_TRANSITION_NOT_ALLOWED) on self-approval,
   *   empty justification, or a non-PENDING_APPROVAL request.
   */
  async approveProvisionally(
    requestId: string,
    justification: string,
    ctx: ActorContext,
    idempotencyKey: string,
  ): Promise<TimeOffRequestRow> {
    const trimmedJustification = justification.trim();
    const inputHash = this.serializer.hash(
      { requestId, approverId: ctx.actorId, justification: trimmedJustification },
      APPROVE_PROVISIONALLY_SPEC,
    );
    const replay = this.checkReplay(idempotencyKey, inputHash);
    if (replay) return replay;

    if (trimmedJustification.length === 0) {
      throw new DomainError({
        code: 'STATE_TRANSITION_NOT_ALLOWED',
        message: 'justification is required for break-glass approval',
      });
    }

    const auth = this.breakGlass.authorize({ actorRole: ctx.actorRole });
    switch (auth.kind) {
      case 'NOT_AUTHORIZED':
        throw new DomainError({ code: 'BREAK_GLASS_NOT_AUTHORIZED' });
      case 'HCM_HEALTHY':
      case 'OUTAGE_THRESHOLD_NOT_MET':
        throw new DomainError({
          code: 'BREAK_GLASS_OUTAGE_THRESHOLD_NOT_MET',
          details: auth.kind === 'OUTAGE_THRESHOLD_NOT_MET'
            ? { outageMs: auth.outageMs, requiredMs: auth.requiredMs }
            : { reason: 'HCM_HEALTHY' },
        });
      case 'OK':
        break;
    }

    const request = this.requireRequest(requestId);
    if (ctx.actorId === request.employeeId) {
      throw new DomainError({
        code: 'STATE_TRANSITION_NOT_ALLOWED',
        message: 'self-approval is prohibited',
      });
    }
    RequestStateMachine.assertTransition(request.state, 'PROVISIONALLY_APPROVED');

    const snapshot = this.buildOutageSnapshot(request, 'break-glass approval');

    const provisionalActionId = randomUUID();
    const at = new Date().toISOString();
    const outageStarted = (this.health.outageStartedAt() ?? new Date()).toISOString();

    this.db.transaction(() => {
      this.provisionalActions.insert({
        id: provisionalActionId,
        type: 'BREAK_GLASS_APPROVAL',
        requestId,
        invokedBy: ctx.actorId,
        invokedAt: at,
        reason: trimmedJustification,
        outageStartObservedAt: outageStarted,
        localStateSnapshot: snapshot,
      });
      this.balance.promoteHold(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
        request.units,
        'pending',
        'provisional',
      );
      this.store.markProvisionallyApproved({
        id: requestId,
        provisionalApprovalId: provisionalActionId,
        approverId: ctx.actorId,
        at,
      });
      this.idempotency.remember(idempotencyKey, inputHash, { requestId });
    })();

    this.audit.emit({
      action: 'BREAK_GLASS_APPROVAL_INVOKED',
      entityType: 'TimeOffRequest',
      entityId: requestId,
      actor: ctx.actorId,
      correlationId: ctx.correlationId,
      before: { state: request.state },
      after: {
        state: 'PROVISIONALLY_APPROVED',
        provisionalActionId,
        justification: trimmedJustification,
        outageStartObservedAt: outageStarted,
      },
    });
    return this.mustFind(requestId);
  }

  // ── cancelProvisionally (TRD §9.5.4) ─────────────────────────────────────

  /**
   * Asymmetric counterpart of `approveProvisionally`. Records a
   * `PROVISIONAL_CANCELLATION` event and transitions the request to
   * `CANCELLATION_PENDING`; the provisional reconciler issues `releaseBalance`
   * to HCM on recovery and settles to `CANCELLED` (TRD §9.5.4).
   *
   * Unlike break-glass approval, this is a credit operation — no role gate,
   * no minimum-outage threshold. The single guardrail is the UI-contract
   * acknowledgement (TRD §9.5.4, Q.α).
   *
   * @throws DomainError(CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT) when
   *   `acknowledgedHcmUnavailable` is not `true`.
   * @throws DomainError(STATE_TRANSITION_NOT_ALLOWED) when the request's
   *   current state cannot transition to `CANCELLATION_PENDING` (only
   *   `APPROVED` and `PROVISIONALLY_APPROVED` can).
   * @throws DomainError(TERMINAL_STATE_REACHED) when the request is terminal.
   */
  async cancelProvisionally(
    requestId: string,
    ctx: ActorContext,
    idempotencyKey: string,
    options: { readonly acknowledgedHcmUnavailable: boolean },
  ): Promise<TimeOffRequestRow> {
    if (!options.acknowledgedHcmUnavailable) {
      throw new DomainError({ code: 'CANCEL_DURING_OUTAGE_REQUIRES_ACKNOWLEDGMENT' });
    }
    const inputHash = this.serializer.hash(
      { requestId, actorId: ctx.actorId, acknowledgedHcmUnavailable: 'true' },
      CANCEL_PROVISIONALLY_SPEC,
    );
    const replay = this.checkReplay(idempotencyKey, inputHash);
    if (replay) return replay;

    const request = this.requireRequest(requestId);
    if (RequestStateMachine.isTerminal(request.state)) {
      throw new DomainError({
        code: 'TERMINAL_STATE_REACHED',
        message: `request is already in terminal state ${request.state}`,
      });
    }
    RequestStateMachine.assertTransition(request.state, 'CANCELLATION_PENDING');

    const snapshot = this.buildOutageSnapshot(request, 'provisional cancellation');

    const provisionalActionId = randomUUID();
    const at = new Date().toISOString();
    const outageStarted = (this.health.outageStartedAt() ?? new Date()).toISOString();

    // No local hold movement: a credit operation is symmetric to an absent
    // debit. HCM still reflects the original debit; the reconciler's
    // `applyHcmUpdate` will surface the credit when `releaseBalance` succeeds.
    // (TRD §9.5.4: "Cancellation is a credit operation; the risk of being
    // wrong is bounded ... at worst, we credit and HCM hasn't actually
    // debited yet, which converges naturally.")
    this.db.transaction(() => {
      this.provisionalActions.insert({
        id: provisionalActionId,
        type: 'PROVISIONAL_CANCELLATION',
        requestId,
        invokedBy: ctx.actorId,
        invokedAt: at,
        reason: 'user-initiated; acknowledgedHcmUnavailable=true',
        outageStartObservedAt: outageStarted,
        localStateSnapshot: snapshot,
      });
      this.store.markCancellationPending({ id: requestId, at });
      this.idempotency.remember(idempotencyKey, inputHash, { requestId });
    })();

    this.audit.emit({
      action: 'PROVISIONAL_CANCELLATION_INVOKED',
      entityType: 'TimeOffRequest',
      entityId: requestId,
      actor: ctx.actorId,
      correlationId: ctx.correlationId,
      before: { state: request.state },
      after: {
        state: 'CANCELLATION_PENDING',
        provisionalActionId,
        acknowledgedHcmUnavailable: true,
        outageStartObservedAt: outageStarted,
      },
    });
    return this.mustFind(requestId);
  }

  // ── reject (TRD §9.3) ────────────────────────────────────────────────────

  async reject(
    requestId: string,
    reason: string,
    ctx: ActorContext,
    idempotencyKey: string,
  ): Promise<TimeOffRequestRow> {
    const inputHash = this.serializer.hash(
      { requestId, approverId: ctx.actorId, reason },
      REJECT_SPEC,
    );
    const replay = this.checkReplay(idempotencyKey, inputHash);
    if (replay) return replay;

    const request = this.requireRequest(requestId);
    if (ctx.actorId === request.employeeId) {
      throw new DomainError({
        code: 'STATE_TRANSITION_NOT_ALLOWED',
        message: 'employees cancel; managers reject',
      });
    }
    RequestStateMachine.assertTransition(request.state, 'REJECTED');

    const at = new Date().toISOString();
    this.db.transaction(() => {
      this.balance.releaseHold(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
        request.units,
        'pending',
      );
      this.store.markRejected({ id: requestId, reason, at });
      this.idempotency.remember(idempotencyKey, inputHash, { requestId });
    })();

    this.audit.emit({
      action: 'REQUEST_REJECTED',
      entityType: 'TimeOffRequest',
      entityId: requestId,
      actor: ctx.actorId,
      correlationId: ctx.correlationId,
      before: { state: request.state },
      after: { state: 'REJECTED', reason },
    });
    return this.mustFind(requestId);
  }

  // ── cancel (TRD §9.4) ────────────────────────────────────────────────────

  async cancel(
    requestId: string,
    ctx: ActorContext,
    idempotencyKey: string,
  ): Promise<TimeOffRequestRow> {
    const inputHash = this.serializer.hash(
      { requestId, actorId: ctx.actorId },
      CANCEL_SPEC,
    );
    const replay = this.checkReplay(idempotencyKey, inputHash);
    if (replay) return replay;

    const request = this.requireRequest(requestId);
    if (RequestStateMachine.isTerminal(request.state)) {
      throw new DomainError({
        code: 'TERMINAL_STATE_REACHED',
        message: `request is already in terminal state ${request.state}`,
      });
    }
    RequestStateMachine.assertTransition(request.state, 'CANCELLED');

    if (request.state === 'PENDING_APPROVAL') {
      const at = new Date().toISOString();
      this.db.transaction(() => {
        this.balance.releaseHold(
          request.employeeId,
          request.locationId,
          request.leaveTypeId,
          request.units,
          'pending',
        );
        this.store.markCancelled({ id: requestId, at });
        this.idempotency.remember(idempotencyKey, inputHash, { requestId });
      })();
      this.audit.emit({
        action: 'REQUEST_CANCELLED',
        entityType: 'TimeOffRequest',
        entityId: requestId,
        actor: ctx.actorId,
        correlationId: ctx.correlationId,
        before: { state: 'PENDING_APPROVAL' },
        after: { state: 'CANCELLED' },
      });
      return this.mustFind(requestId);
    }

    // APPROVED → HCM credit (synchronous; CANCELLATION_PENDING flow is Slice 13).
    let hcmResponse;
    try {
      hcmResponse = await this.hcm.releaseBalance(
        {
          employeeId: request.employeeId,
          locationId: request.locationId,
          leaveTypeId: request.leaveTypeId,
          units: request.units,
        },
        idempotencyKey,
      );
    } catch (err) {
      if (err instanceof HcmTransientError) {
        throw new DomainError({ code: 'HCM_UNAVAILABLE' });
      }
      throw err;
    }

    const at = new Date().toISOString();
    this.db.transaction(() => {
      this.balance.applyHcmUpdate({
        employeeId: request.employeeId,
        locationId: request.locationId,
        leaveTypeId: request.leaveTypeId,
        available: hcmResponse.newAvailable,
        hcmVersion: hcmResponse.hcmVersion,
        hcmEffectiveAt: hcmResponse.appliedAt,
      });
      this.store.markCancelled({ id: requestId, at });
      this.idempotency.remember(idempotencyKey, inputHash, { requestId });
    })();

    this.audit.emit({
      action: 'REQUEST_CANCELLED',
      entityType: 'TimeOffRequest',
      entityId: requestId,
      actor: ctx.actorId,
      correlationId: ctx.correlationId,
      before: { state: 'APPROVED' },
      after: { state: 'CANCELLED', hcmTransactionId: hcmResponse.transactionId },
    });
    return this.mustFind(requestId);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private parseAndValidateInput(input: CreateTimeOffRequestInput): Decimal {
    if (!ISO_DATE_RE.test(input.startDate) || !ISO_DATE_RE.test(input.endDate)) {
      throw new DomainError({
        code: 'INVALID_DATES',
        message: 'startDate and endDate must be YYYY-MM-DD',
      });
    }
    if (input.startDate > input.endDate) {
      throw new DomainError({
        code: 'INVALID_DATES',
        message: 'endDate must be on or after startDate',
      });
    }
    let units: Decimal;
    try {
      units = typeof input.units === 'string' ? parseDecimal(input.units) : input.units;
    } catch (err) {
      throw new DomainError({
        code: 'INVALID_DATES',
        message: `units is not a valid decimal: ${(err as Error).message}`,
      });
    }
    if (units.lte(0)) {
      throw new DomainError({ code: 'INVALID_DATES', message: 'units must be positive' });
    }
    return units;
  }

  /**
   * Lazily load the balance row from HCM if absent locally. The fetch result
   * flows through `BalanceService.applyHcmUpdate`, which inserts at zero
   * holds + `SYNCED`.
   */
  private async ensureBalanceLoaded(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
  ): Promise<void> {
    if (this.balance.get(employeeId, locationId, leaveTypeId) !== null) return;
    let response;
    try {
      response = await this.hcm.fetchBalance({ employeeId, locationId, leaveTypeId });
    } catch (err) {
      if (err instanceof HcmEmployeeNotFoundError) {
        throw new DomainError({ code: 'EMPLOYEE_NOT_BOOTSTRAPPED' });
      }
      if (err instanceof HcmPermanentError && err.reason === 'INVALID_DIMENSION') {
        throw new DomainError({ code: 'INVALID_DIMENSION' });
      }
      throw err; // transient / contract violations propagate
    }
    this.balance.applyHcmUpdate({
      employeeId: response.employeeId,
      locationId: response.locationId,
      leaveTypeId: response.leaveTypeId,
      available: response.available,
      hcmVersion: response.hcmVersion,
      hcmEffectiveAt: response.appliedAt,
    });
  }

  private checkReplay(idempotencyKey: string, inputHash: string): TimeOffRequestRow | null {
    const resolution = this.idempotency.resolve<CachedResponse>(idempotencyKey, inputHash);
    if (resolution.kind === 'conflict') {
      throw new DomainError({ code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT' });
    }
    if (resolution.kind === 'replay') {
      const row = this.store.find(resolution.response.requestId);
      if (row === null) {
        throw new Error(
          `idempotency cache references missing request ${resolution.response.requestId}`,
        );
      }
      return row;
    }
    return null;
  }

  private requireRequest(id: string): TimeOffRequestRow {
    const row = this.store.find(id);
    if (row === null) throw new DomainError({ code: 'REQUEST_NOT_FOUND' });
    return row;
  }

  private mustFind(id: string): TimeOffRequestRow {
    const row = this.store.find(id);
    if (row === null) throw new Error(`internal: request ${id} disappeared mid-saga`);
    return row;
  }

  /**
   * Captures the request, its current balance, and the covering employment
   * period at the moment of a provisional decision (TRD §5.6.1). The reconciler
   * nullifies this on CONFIRMED/NO_OP outcomes but retains the full snapshot
   * on REJECTED_ESCALATED so HR can investigate.
   */
  private buildOutageSnapshot(
    request: TimeOffRequestRow,
    operation: string,
  ): Readonly<Record<string, unknown>> {
    const balanceRow = this.balance.get(
      request.employeeId,
      request.locationId,
      request.leaveTypeId,
    );
    if (balanceRow === null) {
      throw new Error(`BalanceService: no balance exists for ${operation} of ${request.id}`);
    }
    const period =
      this.employment
        .history(request.employeeId)
        .find(
          (p) =>
            p.effectiveFrom <= request.startDate &&
            (p.effectiveTo === null || p.effectiveTo >= request.endDate),
        ) ?? null;
    return {
      balance: serializeBalanceRow(balanceRow),
      request: serializeRequestRow(request),
      employmentPeriod: period
        ? {
            locationId: period.locationId,
            effectiveFrom: period.effectiveFrom,
            effectiveTo: period.effectiveTo,
          }
        : null,
    };
  }
}

// ─── Snapshot serialization (JSON-safe forms) ───────────────────────────────

function serializeBalanceRow(
  row: import('../balance/balance.store').BalanceRow,
): Readonly<Record<string, unknown>> {
  return {
    employeeId: row.employeeId,
    locationId: row.locationId,
    leaveTypeId: row.leaveTypeId,
    available: row.available.toFixed(),
    pendingHold: row.holds.pending.toFixed(),
    approvedHold: row.holds.approved.toFixed(),
    provisionalHold: row.holds.provisional.toFixed(),
    hcmVersion: row.hcmVersion.toString(),
    state: row.state,
  };
}

function serializeRequestRow(row: TimeOffRequestRow): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    employeeId: row.employeeId,
    locationId: row.locationId,
    leaveTypeId: row.leaveTypeId,
    startDate: row.startDate,
    endDate: row.endDate,
    units: row.units.toFixed(),
    state: row.state,
  };
}
