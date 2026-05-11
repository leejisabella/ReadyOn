import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import { BalanceStore } from '../persistence/balance.store';
import { DATABASE } from '../persistence/database.token';
import { EmployeeStore } from '../persistence/employee.store';
import { EmploymentStore } from '../persistence/employment.store';
import { LeaveTypeStore } from '../persistence/leave-type.store';
import { resetSchema } from '../persistence/migrations';
import { TransactionStore } from '../persistence/transaction.store';
import { VersionStore } from '../persistence/version.store';
import { ZodPipe } from '../common/zod.pipe';

const SetBalanceSchema = z
  .object({
    employeeId: z.string().min(1),
    locationId: z.string().min(1),
    leaveTypeId: z.string().min(1),
    available: z.string().min(1),
  })
  .strict();

const SetEmploymentSchema = z
  .object({
    employeeId: z.string().min(1),
    locationId: z.string().min(1),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

const SetLeaveTypeAvailabilitySchema = z
  .object({
    locationId: z.string().min(1),
    leaveTypeId: z.string().min(1),
    isActive: z.boolean(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

const CreateEmployeeSchema = z
  .object({ employeeId: z.string().min(1) })
  .strict();

const DeleteEmployeeSchema = z
  .object({ employeeId: z.string().min(1) })
  .strict();

/**
 * Test-driving admin surface. Every endpoint is idempotent (upsert semantics)
 * so test setup is order-independent.
 *
 * NOT part of TRD §17.2's public HCM contract — these endpoints exist solely
 * to drive mock state from tests via {@link MockHcmTestHarness} (Slice 5).
 */
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly balances: BalanceStore,
    private readonly employees: EmployeeStore,
    private readonly employment: EmploymentStore,
    private readonly leaveTypes: LeaveTypeStore,
    private readonly transactions: TransactionStore,
    private readonly versions: VersionStore,
  ) {}

  @Post('setBalance')
  @HttpCode(204)
  setBalance(@Body(new ZodPipe(SetBalanceSchema)) body: z.output<typeof SetBalanceSchema>): void {
    this.balances.upsert({
      employeeId: body.employeeId,
      locationId: body.locationId,
      leaveTypeId: body.leaveTypeId,
      available: new Decimal(body.available),
      hcmVersion: this.versions.next(),
      appliedAt: new Date().toISOString(),
    });
  }

  @Post('setEmployment')
  @HttpCode(204)
  setEmployment(
    @Body(new ZodPipe(SetEmploymentSchema)) body: z.output<typeof SetEmploymentSchema>,
  ): void {
    this.employment.upsert({
      employeeId: body.employeeId,
      locationId: body.locationId,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
      hcmVersion: this.versions.next(),
    });
  }

  @Post('setLeaveTypeAvailability')
  @HttpCode(204)
  setLeaveTypeAvailability(
    @Body(new ZodPipe(SetLeaveTypeAvailabilitySchema))
    body: z.output<typeof SetLeaveTypeAvailabilitySchema>,
  ): void {
    this.leaveTypes.upsert({
      locationId: body.locationId,
      leaveTypeId: body.leaveTypeId,
      isActive: body.isActive,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
      hcmVersion: this.versions.next(),
    });
  }

  @Post('createEmployee')
  @HttpCode(204)
  createEmployee(
    @Body(new ZodPipe(CreateEmployeeSchema)) body: z.output<typeof CreateEmployeeSchema>,
  ): void {
    if (this.employees.find(body.employeeId)) return; // idempotent
    this.employees.insert({
      employeeId: body.employeeId,
      hcmVersion: this.versions.next(),
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Rev 3.1 (Q.ν) — exposes employee deletion so tests can exercise the
   * `EMPLOYEE_NOT_FOUND_AT_HCM` branch of the provisional reconciler.
   */
  @Post('deleteEmployee')
  @HttpCode(204)
  deleteEmployee(
    @Body(new ZodPipe(DeleteEmployeeSchema)) body: z.output<typeof DeleteEmployeeSchema>,
  ): void {
    this.employees.delete(body.employeeId);
  }

  @Post('reset')
  @HttpCode(204)
  reset(): void {
    resetSchema(this.db);
  }

  @Get('state')
  state() {
    return {
      currentHcmVersion: this.versions.current().toString(),
      employees: this.employees.list().map((e) => ({
        employeeId: e.employeeId,
        hcmVersion: e.hcmVersion.toString(),
        createdAt: e.createdAt,
      })),
      employment: this.employment.listAll().map((p) => ({
        employeeId: p.employeeId,
        locationId: p.locationId,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo,
        hcmVersion: p.hcmVersion.toString(),
      })),
      leaveTypes: this.leaveTypes.listAll().map((l) => ({
        locationId: l.locationId,
        leaveTypeId: l.leaveTypeId,
        isActive: l.isActive,
        effectiveFrom: l.effectiveFrom,
        effectiveTo: l.effectiveTo,
        hcmVersion: l.hcmVersion.toString(),
      })),
      balances: this.balances.listAll().map((b) => ({
        employeeId: b.employeeId,
        locationId: b.locationId,
        leaveTypeId: b.leaveTypeId,
        available: b.available.toFixed(),
        hcmVersion: b.hcmVersion.toString(),
        appliedAt: b.appliedAt,
      })),
      transactions: this.transactions.listAll().map((t) => ({
        transactionId: t.transactionId,
        idempotencyKey: t.idempotencyKey,
        employeeId: t.employeeId,
        locationId: t.locationId,
        leaveTypeId: t.leaveTypeId,
        deltaApplied: t.deltaApplied.toFixed(),
        newAvailable: t.newAvailable.toFixed(),
        hcmVersion: t.hcmVersion.toString(),
        appliedAt: t.appliedAt,
        outcome: t.outcome,
        rejectionReason: t.rejectionReason,
      })),
    };
  }
}
