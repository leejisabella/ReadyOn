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
import { DATABASE } from '../../infrastructure/persistence/database.token';
import { BalanceService } from '../balance/balance.service';
import { EmployeeBootstrapService } from '../employee-bootstrap/employee-bootstrap.service';
import { EmploymentService } from '../employment/employment.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { LeaveTypeAvailabilityService } from '../leave-type-availability/leave-type-availability.service';
import { RequestStateMachine } from './request-state-machine';
import { RequestStore, type TimeOffRequestRow } from './request.store';

/** Caller-supplied envelope tagged onto every mutation for audit + role checks. */
export interface ActorContext {
  readonly actorId: string;
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

/**
 * The request lifecycle saga (TRD §9.1–§9.4, normal path).
 *
 * Every mutation has the same shape:
 *  1. Compute a canonical hash of the inputs and look up the idempotency
 *     cache — `replay` returns the prior result, `conflict` raises
 *     `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`.
 *  2. Validate inputs and resolve the dimensions (employment, leave type).
 *  3. Call HCM when the operation is dispositive (approve, cancel-of-approved);
 *     map error categories onto `DomainError` codes.
 *  4. Atomically (single SQLite transaction) update the request row, the
 *     balance buckets, and stamp the idempotency cache.
 *
 * Break-glass, the outbox-driven async commit path, and CANCELLATION_PENDING
 * are deferred to Slices 13–15.
 *
 * @ref docs/01_TRD.md §9.1–§9.4, §14.1
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
    @Inject(HCM_PORT) private readonly hcm: HcmPort,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  // ── create (TRD §9.1) ────────────────────────────────────────────────────

  async create(
    input: CreateTimeOffRequestInput,
    _ctx: ActorContext,
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
}
