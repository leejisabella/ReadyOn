import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@time-off/domain-types';
import { HcmEmployeeNotFoundError, type HcmPort } from '@time-off/hcm-port';
import { HCM_PORT } from '../../infrastructure/hcm/hcm-adapter.module';
import { EmploymentService } from '../employment/employment.service';
import { EmployeeStore, type EmployeeRow } from './employee.store';

/**
 * Input passed by the inbox processor when an `EMPLOYEE_CREATED` webhook
 * arrives. The processor unwraps the envelope before calling the service.
 */
export interface EmployeeCreatedSnapshot {
  readonly employeeId: string;
  readonly hcmVersion: bigint;
  readonly initialEmployment: {
    readonly locationId: string;
    readonly effectiveFrom: string;
  };
}

/** Input passed by the daily batch reconciler for every employee in the dump. */
export interface BatchEmployeeRow {
  readonly employeeId: string;
  readonly hcmVersion: bigint;
}

/**
 * Three-path employee bootstrap (TRD §11, ADR-012).
 *
 *   - {@link handleEmployeeCreatedEvent} — happy path; the inbox processor
 *     calls this on every `EMPLOYEE_CREATED` event.
 *   - {@link ensureBootstrapped} — safety-net path; called at the entry of
 *     every employee-referencing API operation. Falls back to lazy HCM
 *     pull when the local row is absent.
 *   - {@link bootstrapFromBatch} — catch-all path; called by the daily batch
 *     reconciler for every row whose employee isn't yet known.
 *
 * All three paths converge on `EmployeeStore.insertIfAbsent`, so they are
 * race-safe — the first writer wins and the rest are silent no-ops.
 *
 * @ref docs/01_TRD.md §11, §14.6 (EMPLOYEE_NOT_BOOTSTRAPPED)
 * @ref docs/04_Module_Plan.md §3.6
 */
@Injectable()
export class EmployeeBootstrapService {
  constructor(
    private readonly store: EmployeeStore,
    private readonly employment: EmploymentService,
    @Inject(HCM_PORT) private readonly hcm: HcmPort,
  ) {}

  /**
   * Return the local employee row. If absent, lazy-pull from HCM and insert.
   *
   * @throws DomainError(EMPLOYEE_NOT_BOOTSTRAPPED) when HCM also has no
   *   record of the employee — the only definitive "doesn't exist" signal
   *   the saga can produce.
   * @throws HcmTransientError / HcmPermanentError when the pull fails for
   *   transport reasons — these propagate so the caller can retry.
   */
  async ensureBootstrapped(employeeId: string): Promise<EmployeeRow> {
    const existing = this.store.find(employeeId);
    if (existing) return existing;

    let response;
    try {
      response = await this.hcm.fetchEmployee(employeeId);
    } catch (err) {
      if (err instanceof HcmEmployeeNotFoundError) {
        throw new DomainError({
          code: 'EMPLOYEE_NOT_BOOTSTRAPPED',
          message: `HCM has no record of employee ${employeeId}.`,
        });
      }
      throw err;
    }

    this.store.insertIfAbsent({
      employeeId: response.employeeId,
      bootstrappedAt: new Date().toISOString(),
      bootstrapSource: 'LAZY_PULL',
      hcmVersion: response.hcmVersion,
      lastSeenInBatchAt: null,
    });
    for (const period of response.employment) {
      this.employment.applyHcmUpdate({
        employeeId: response.employeeId,
        locationId: period.locationId,
        effectiveFrom: period.effectiveFrom,
        effectiveTo: period.effectiveTo ?? null,
        hcmVersion: period.hcmVersion,
      });
    }
    return this.store.find(employeeId) ?? throwInsertRace(employeeId);
  }

  /**
   * Webhook-driven path. Inserts the employee row and the initial employment
   * period from the event payload. Idempotent — duplicate deliveries are
   * silent no-ops at both layers.
   */
  async handleEmployeeCreatedEvent(snapshot: EmployeeCreatedSnapshot): Promise<void> {
    this.store.insertIfAbsent({
      employeeId: snapshot.employeeId,
      bootstrappedAt: new Date().toISOString(),
      bootstrapSource: 'WEBHOOK',
      hcmVersion: snapshot.hcmVersion,
      lastSeenInBatchAt: null,
    });
    this.employment.applyHcmUpdate({
      employeeId: snapshot.employeeId,
      locationId: snapshot.initialEmployment.locationId,
      effectiveFrom: snapshot.initialEmployment.effectiveFrom,
      effectiveTo: null,
      hcmVersion: snapshot.hcmVersion,
    });
  }

  /**
   * Batch-driven path. Inserts the employee row when missing and stamps
   * `lastSeenInBatchAt` on every call. Employment data is not in the batch
   * dump (TRD §11.4) — it arrives via webhook or lazy-pull.
   */
  async bootstrapFromBatch(row: BatchEmployeeRow): Promise<void> {
    const now = new Date().toISOString();
    this.store.insertIfAbsent({
      employeeId: row.employeeId,
      bootstrappedAt: now,
      bootstrapSource: 'BATCH',
      hcmVersion: row.hcmVersion,
      lastSeenInBatchAt: now,
    });
    this.store.recordSeenInBatch(row.employeeId, now);
  }
}

/** Defensive — should never fire because INSERT OR IGNORE leaves the row present. */
function throwInsertRace(employeeId: string): never {
  throw new Error(`Bootstrap race: employee ${employeeId} was inserted then disappeared`);
}
