import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { EmployeeStore } from '../persistence/employee.store';
import { TransactionStore } from '../persistence/transaction.store';
import { HcmHttpError } from '../common/hcm-http-error';
import { ZodPipe } from '../common/zod.pipe';

const QueryBodySchema = z
  .object({
    employeeId: z.string().min(1),
    locationId: z.string().min(1),
    leaveTypeId: z.string().min(1),
    idempotencyKey: z.string().min(1).optional(),
    window: z
      .object({
        start: z.string().min(1),
        end: z.string().min(1),
      })
      .optional(),
  })
  .strict();

/**
 * Pre-flight transaction-history endpoint (Rev 3, TRD §13.2.1). The
 * provisional reconciler calls this with its `ProvisionalAction.id` as the
 * `idempotencyKey` filter to detect transactions HCM already applied.
 *
 * Returns 404 + `EMPLOYEE_NOT_FOUND` when the queried employee has no HCM
 * record (Rev 3.1, Q.ν — the reconciler routes to ESCALATED_TO_HR).
 *
 * Body format mirrors {@link HcmTransactionQuery}; using POST so the optional
 * `window` object can be expressed cleanly without query-string serialization.
 */
@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionStore,
    private readonly employees: EmployeeStore,
  ) {}

  @Post('query')
  @HttpCode(200)
  query(@Body(new ZodPipe(QueryBodySchema)) body: z.output<typeof QueryBodySchema>) {
    if (!this.employees.find(body.employeeId)) {
      throw new HcmHttpError(404, 'EMPLOYEE_NOT_FOUND', `Unknown employee ${body.employeeId}.`);
    }
    return this.transactions.query(body).map((record) => ({
      transactionId: record.transactionId,
      ...(record.idempotencyKey !== null ? { idempotencyKey: record.idempotencyKey } : {}),
      deltaApplied: record.deltaApplied.toFixed(),
      appliedAt: record.appliedAt,
      hcmVersion: record.hcmVersion.toString(),
    }));
  }
}
