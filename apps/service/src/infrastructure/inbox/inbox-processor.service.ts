import { Inject, Injectable } from '@nestjs/common';
import { parseDecimal } from '@time-off/decimal-scalar';
import { BalanceService } from '../../domain/balance/balance.service';
import { EmployeeBootstrapService } from '../../domain/employee-bootstrap/employee-bootstrap.service';
import { EmploymentService } from '../../domain/employment/employment.service';
import { LeaveTypeAvailabilityService } from '../../domain/leave-type-availability/leave-type-availability.service';
import { InboxStore, type InboxEventRow } from './inbox.store';

export interface InboxProcessorOptions {
  readonly batchSize?: number;
  readonly now?: () => number;
}

export interface InboxTickResult {
  readonly claimed: number;
  readonly processed: number;
  readonly failed: number;
}

/**
 * Drains the inbox: claim → route by event type to the right domain
 * service. Each handler receives a normalized snapshot (the wire envelope
 * is already validated at the webhook boundary; we just deserialize and
 * dispatch).
 *
 * @ref docs/01_TRD.md §10.1, §10.2
 * @ref docs/04_Module_Plan.md §3.14
 */
@Injectable()
export class InboxProcessor {
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(
    private readonly store: InboxStore,
    private readonly balance: BalanceService,
    private readonly employment: EmploymentService,
    private readonly leaveTypes: LeaveTypeAvailabilityService,
    private readonly bootstrap: EmployeeBootstrapService,
    @Inject('INBOX_PROCESSOR_OPTIONS') options: InboxProcessorOptions,
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.now = options.now ?? Date.now;
  }

  async tick(): Promise<InboxTickResult> {
    const claimed = this.store.claimUnprocessed(this.batchSize);
    let processed = 0;
    let failed = 0;

    for (const row of claimed) {
      try {
        await this.dispatch(row);
        this.store.markProcessed(row.id, this.iso());
        processed += 1;
      } catch (err) {
        this.store.markError(row.id, serializeError(err));
        failed += 1;
      }
    }

    return { claimed: claimed.length, processed, failed };
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  private async dispatch(row: InboxEventRow): Promise<void> {
    switch (row.type) {
      case 'BALANCE_UPDATED':
        return this.handleBalanceUpdated(row);
      case 'EMPLOYMENT_CHANGED':
        return this.handleEmploymentChanged(row);
      case 'LEAVE_TYPE_CHANGED':
        return this.handleLeaveTypeChanged(row);
      case 'EMPLOYEE_CREATED':
        return this.handleEmployeeCreated(row);
    }
  }

  private async handleBalanceUpdated(row: InboxEventRow): Promise<void> {
    const p = row.payload;
    this.balance.applyHcmUpdate({
      employeeId: requireString(p.employeeId, row.id, 'employeeId'),
      locationId: requireString(p.locationId, row.id, 'locationId'),
      leaveTypeId: requireString(p.leaveTypeId, row.id, 'leaveTypeId'),
      available: parseDecimal(requireString(p.available, row.id, 'available')),
      hcmVersion: row.hcmVersion,
      hcmEffectiveAt: row.receivedAt,
    });
  }

  private async handleEmploymentChanged(row: InboxEventRow): Promise<void> {
    const p = row.payload;
    this.employment.applyHcmUpdate({
      employeeId: requireString(p.employeeId, row.id, 'employeeId'),
      locationId: requireString(p.locationId, row.id, 'locationId'),
      effectiveFrom: requireString(p.effectiveFrom, row.id, 'effectiveFrom'),
      effectiveTo: typeof p.effectiveTo === 'string' ? p.effectiveTo : null,
      hcmVersion: row.hcmVersion,
    });
  }

  private async handleLeaveTypeChanged(row: InboxEventRow): Promise<void> {
    const p = row.payload;
    if (typeof p.isActive !== 'boolean') {
      throw new Error(`inbox ${row.id}: leave type payload missing isActive`);
    }
    this.leaveTypes.applyHcmUpdate({
      locationId: requireString(p.locationId, row.id, 'locationId'),
      leaveTypeId: requireString(p.leaveTypeId, row.id, 'leaveTypeId'),
      effectiveFrom: requireString(p.effectiveFrom, row.id, 'effectiveFrom'),
      effectiveTo: typeof p.effectiveTo === 'string' ? p.effectiveTo : null,
      isActive: p.isActive,
      hcmVersion: row.hcmVersion,
    });
  }

  private async handleEmployeeCreated(row: InboxEventRow): Promise<void> {
    const p = row.payload;
    const employment = p.employment as Record<string, unknown> | undefined;
    if (!employment) {
      throw new Error(`inbox ${row.id}: employee created payload missing employment`);
    }
    await this.bootstrap.handleEmployeeCreatedEvent({
      employeeId: requireString(p.employeeId, row.id, 'employeeId'),
      hcmVersion: row.hcmVersion,
      initialEmployment: {
        locationId: requireString(employment.locationId, row.id, 'employment.locationId'),
        effectiveFrom: requireString(employment.effectiveFrom, row.id, 'employment.effectiveFrom'),
      },
    });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

function requireString(value: unknown, eventId: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`inbox ${eventId}: payload field '${path}' must be a non-empty string`);
  }
  return value;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
