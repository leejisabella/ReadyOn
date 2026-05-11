import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { BalanceStore } from '../persistence/balance.store';
import { EmployeeStore } from '../persistence/employee.store';
import {
  TransactionStore,
  type TransactionRecord,
} from '../persistence/transaction.store';
import { VersionStore } from '../persistence/version.store';

/**
 * Outcome of a reserve/release call. Always carries both the HTTP status code
 * and the body so callers can replay it verbatim (TRD §14.1 idempotent retry).
 *
 * Accepted outcomes carry the mutation confirmation (TRD §13.2); rejections
 * carry a `reason` + `message` body that downstream adapters map to
 * {@link HcmPermanentError}.
 */
export type MutationOutcome =
  | {
      readonly kind: 'ACCEPTED';
      readonly statusCode: 200;
      readonly body: {
        readonly transactionId: string;
        readonly deltaApplied: string;
        readonly newAvailable: string;
        readonly hcmVersion: string;
        readonly appliedAt: string;
      };
    }
  | {
      readonly kind: 'REJECTED';
      readonly statusCode: 400 | 404;
      readonly body: {
        readonly error: RejectionReason;
        readonly message: string;
      };
    };

/**
 * `EMPLOYEE_NOT_FOUND` (Rev 3.1, Q.ν) is returned as 404 so the adapter
 * raises {@link HcmEmployeeNotFoundError}. Other rejections are 400.
 */
export type RejectionReason =
  | 'EMPLOYEE_NOT_FOUND'
  | 'INVALID_DIMENSION'
  | 'INSUFFICIENT_BALANCE';

export interface MutationRequest {
  readonly employeeId: string;
  readonly locationId: string;
  readonly leaveTypeId: string;
  readonly units: Decimal;
  readonly idempotencyKey: string;
}

/**
 * Reserve/release business logic for the Mock HCM.
 *
 * Both operations:
 *
 *   1. Replay any prior outcome stored under the same `idempotencyKey`.
 *   2. Otherwise, apply the delta inside a single SQLite transaction —
 *      lookup balance → check sufficiency (reserve only) → bump version →
 *      upsert balance → record transaction → return response.
 *
 * Rejections (insufficient balance, missing dimension) are stored as
 * `REJECTED` transactions so idempotent retries of a rejected request also
 * replay the same 4xx body.
 *
 * @ref docs/01_TRD.md §13.2 (mutation confirmation), §14.1 (idempotency)
 */
@Injectable()
export class BalanceService {
  constructor(
    private readonly balances: BalanceStore,
    private readonly employees: EmployeeStore,
    private readonly transactions: TransactionStore,
    private readonly versions: VersionStore,
  ) {}

  reserve(req: MutationRequest): MutationOutcome {
    return this.applyDelta(req, req.units.neg());
  }

  release(req: MutationRequest): MutationOutcome {
    return this.applyDelta(req, req.units);
  }

  /**
   * Core flow. `delta` is the signed change to apply: negative for reserve,
   * positive for release. Sufficiency is enforced only when `delta < 0`.
   */
  private applyDelta(req: MutationRequest, delta: Decimal): MutationOutcome {
    const replayed = this.transactions.findByIdempotencyKey(req.idempotencyKey);
    if (replayed) {
      return this.toOutcome(replayed);
    }

    if (!this.employees.find(req.employeeId)) {
      return this.recordRejection(req, {
        reason: 'EMPLOYEE_NOT_FOUND',
        statusCode: 404,
        message: `HCM has no record of employee ${req.employeeId}.`,
      });
    }

    const current = this.balances.find(req.employeeId, req.locationId, req.leaveTypeId);
    if (!current) {
      return this.recordRejection(req, {
        reason: 'INVALID_DIMENSION',
        statusCode: 400,
        message: `No balance is configured for (${req.employeeId}, ${req.locationId}, ${req.leaveTypeId}).`,
      });
    }

    if (delta.isNeg() && current.available.plus(delta).lt(0)) {
      return this.recordRejection(req, {
        reason: 'INSUFFICIENT_BALANCE',
        statusCode: 400,
        message: `Available ${current.available.toFixed()} cannot satisfy debit of ${req.units.toFixed()}.`,
        snapshot: current,
      });
    }

    return this.commitAccepted(req, delta, current.available);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private commitAccepted(
    req: MutationRequest,
    delta: Decimal,
    currentAvailable: Decimal,
  ): MutationOutcome {
    const newAvailable = currentAvailable.plus(delta);
    const hcmVersion = this.versions.next();
    const transactionId = randomUUID();
    const appliedAt = new Date().toISOString();

    const body = {
      transactionId,
      deltaApplied: delta.toFixed(),
      newAvailable: newAvailable.toFixed(),
      hcmVersion: hcmVersion.toString(),
      appliedAt,
    };

    this.balances.upsert({
      employeeId: req.employeeId,
      locationId: req.locationId,
      leaveTypeId: req.leaveTypeId,
      available: newAvailable,
      hcmVersion,
      appliedAt,
    });

    this.transactions.insert({
      transactionId,
      idempotencyKey: req.idempotencyKey,
      employeeId: req.employeeId,
      locationId: req.locationId,
      leaveTypeId: req.leaveTypeId,
      deltaApplied: delta,
      newAvailable,
      hcmVersion,
      appliedAt,
      outcome: 'ACCEPTED',
      rejectionReason: null,
      statusCode: 200,
      responseBody: body,
    });

    return { kind: 'ACCEPTED', statusCode: 200, body };
  }

  private recordRejection(
    req: MutationRequest,
    detail: {
      readonly reason: RejectionReason;
      readonly statusCode: 400 | 404;
      readonly message: string;
      readonly snapshot?: { readonly available: Decimal; readonly hcmVersion: bigint };
    },
  ): MutationOutcome {
    const body = { error: detail.reason, message: detail.message };
    const hcmVersion = detail.snapshot?.hcmVersion ?? this.versions.current();
    const newAvailable = detail.snapshot?.available ?? new Decimal(0);

    this.transactions.insert({
      transactionId: randomUUID(),
      idempotencyKey: req.idempotencyKey,
      employeeId: req.employeeId,
      locationId: req.locationId,
      leaveTypeId: req.leaveTypeId,
      deltaApplied: new Decimal(0),
      newAvailable,
      hcmVersion,
      appliedAt: new Date().toISOString(),
      outcome: 'REJECTED',
      rejectionReason: detail.reason,
      statusCode: detail.statusCode,
      responseBody: body,
    });

    return { kind: 'REJECTED', statusCode: detail.statusCode, body };
  }

  private toOutcome(record: TransactionRecord): MutationOutcome {
    if (record.outcome === 'ACCEPTED') {
      return { kind: 'ACCEPTED', statusCode: 200, body: record.responseBody as AcceptedBody };
    }
    return {
      kind: 'REJECTED',
      statusCode: record.statusCode === 404 ? 404 : 400,
      body: record.responseBody as RejectedBody,
    };
  }
}

type AcceptedBody = Extract<MutationOutcome, { kind: 'ACCEPTED' }>['body'];
type RejectedBody = Extract<MutationOutcome, { kind: 'REJECTED' }>['body'];
