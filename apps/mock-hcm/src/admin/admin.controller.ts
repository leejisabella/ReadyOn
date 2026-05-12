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

const SetTransactionSchema = z
  .object({
    transactionId: z.string().min(1),
    idempotencyKey: z.string().min(1).nullable().optional(),
    employeeId: z.string().min(1),
    locationId: z.string().min(1),
    leaveTypeId: z.string().min(1),
    deltaApplied: z.string().min(1),
    newAvailable: z.string().min(1),
    hcmVersion: z.string().regex(/^\d+$/),
    appliedAt: z.string().min(1),
    outcome: z.enum(['ACCEPTED', 'REJECTED']).optional(),
    rejectionReason: z.string().nullable().optional(),
  })
  .strict();

const SnapshotSchema = z
  .object({
    currentHcmVersion: z.string().regex(/^\d+$/),
    employees: z.array(
      z
        .object({
          employeeId: z.string().min(1),
          hcmVersion: z.string().regex(/^\d+$/),
          createdAt: z.string().min(1),
        })
        .strict(),
    ),
    employment: z.array(
      z
        .object({
          employeeId: z.string().min(1),
          locationId: z.string().min(1),
          effectiveFrom: z.string().min(1),
          effectiveTo: z.string().nullable(),
          hcmVersion: z.string().regex(/^\d+$/),
        })
        .strict(),
    ),
    leaveTypes: z.array(
      z
        .object({
          locationId: z.string().min(1),
          leaveTypeId: z.string().min(1),
          isActive: z.boolean(),
          effectiveFrom: z.string().min(1),
          effectiveTo: z.string().nullable(),
          hcmVersion: z.string().regex(/^\d+$/),
        })
        .strict(),
    ),
    balances: z.array(
      z
        .object({
          employeeId: z.string().min(1),
          locationId: z.string().min(1),
          leaveTypeId: z.string().min(1),
          available: z.string().min(1),
          hcmVersion: z.string().regex(/^\d+$/),
          appliedAt: z.string().min(1),
        })
        .strict(),
    ),
    transactions: z.array(
      z
        .object({
          transactionId: z.string().min(1),
          idempotencyKey: z.string().nullable(),
          employeeId: z.string().min(1),
          locationId: z.string().min(1),
          leaveTypeId: z.string().min(1),
          deltaApplied: z.string().min(1),
          newAvailable: z.string().min(1),
          hcmVersion: z.string().regex(/^\d+$/),
          appliedAt: z.string().min(1),
          outcome: z.enum(['ACCEPTED', 'REJECTED']),
          rejectionReason: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Test-driving admin surface. Every endpoint is idempotent (upsert semantics)
 * so test setup is order-independent.
 *
 * NOT part of TRD §17.2's public HCM contract — these endpoints exist solely
 * to drive mock state from tests via {@link MockHcmTestHarness}.
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

  /**
   * Insert a synthetic transaction (used by Layer 21 to test the
   * `queryTransactions` history-window boundary, Rev 3.1 Q.κ). The endpoint
   * accepts both ACCEPTED and REJECTED outcomes so tests can plant either.
   */
  @Post('setTransaction')
  @HttpCode(204)
  setTransaction(
    @Body(new ZodPipe(SetTransactionSchema)) body: z.output<typeof SetTransactionSchema>,
  ): void {
    this.transactions.insert({
      transactionId: body.transactionId,
      idempotencyKey: body.idempotencyKey ?? null,
      employeeId: body.employeeId,
      locationId: body.locationId,
      leaveTypeId: body.leaveTypeId,
      deltaApplied: new Decimal(body.deltaApplied),
      newAvailable: new Decimal(body.newAvailable),
      hcmVersion: BigInt(body.hcmVersion),
      appliedAt: body.appliedAt,
      outcome: body.outcome ?? 'ACCEPTED',
      rejectionReason: body.rejectionReason ?? null,
      statusCode: body.outcome === 'REJECTED' ? 400 : 200,
      responseBody: { transactionId: body.transactionId },
    });
  }

  /**
   * Restore the full mock state from a {@link state} snapshot. The mock is
   * reset first, then every row is replayed and the hcmVersion counter is
   * pinned to the snapshot's value. Used by crash-recovery tests
   * (`MockHcmTestHarness.restoreSnapshot`).
   */
  @Post('restoreState')
  @HttpCode(204)
  restoreState(@Body(new ZodPipe(SnapshotSchema)) snap: z.output<typeof SnapshotSchema>): void {
    resetSchema(this.db);
    for (const e of snap.employees) {
      this.employees.insert({
        employeeId: e.employeeId,
        hcmVersion: BigInt(e.hcmVersion),
        createdAt: e.createdAt,
      });
    }
    for (const p of snap.employment) {
      this.employment.upsert({
        employeeId: p.employeeId,
        locationId: p.locationId,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo,
        hcmVersion: BigInt(p.hcmVersion),
      });
    }
    for (const l of snap.leaveTypes) {
      this.leaveTypes.upsert({
        locationId: l.locationId,
        leaveTypeId: l.leaveTypeId,
        isActive: l.isActive,
        effectiveFrom: l.effectiveFrom,
        effectiveTo: l.effectiveTo,
        hcmVersion: BigInt(l.hcmVersion),
      });
    }
    for (const b of snap.balances) {
      this.balances.upsert({
        employeeId: b.employeeId,
        locationId: b.locationId,
        leaveTypeId: b.leaveTypeId,
        available: new Decimal(b.available),
        hcmVersion: BigInt(b.hcmVersion),
        appliedAt: b.appliedAt,
      });
    }
    for (const t of snap.transactions) {
      this.transactions.insert({
        transactionId: t.transactionId,
        idempotencyKey: t.idempotencyKey,
        employeeId: t.employeeId,
        locationId: t.locationId,
        leaveTypeId: t.leaveTypeId,
        deltaApplied: new Decimal(t.deltaApplied),
        newAvailable: new Decimal(t.newAvailable),
        hcmVersion: BigInt(t.hcmVersion),
        appliedAt: t.appliedAt,
        outcome: t.outcome,
        rejectionReason: t.rejectionReason,
        statusCode: t.outcome === 'REJECTED' ? 400 : 200,
        responseBody: { transactionId: t.transactionId },
      });
    }
    this.versions.setTo(BigInt(snap.currentHcmVersion));
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
