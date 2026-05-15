import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { parseDecimal } from '@time-off/decimal-scalar';
import { z } from 'zod';
import { BalanceStore } from '../persistence/balance.store';
import { EmployeeStore } from '../persistence/employee.store';
import { HcmHttpError } from '../common/hcm-http-error';
import { ZodPipe } from '../common/zod.pipe';
import { BalanceService } from './balance.service';

const MutationBodySchema = z
  .object({
    employeeId: z.string().min(1),
    locationId: z.string().min(1),
    leaveTypeId: z.string().min(1),
    units: z.string().min(1),
  })
  .strict();

/**
 * HTTP surface for balance reads, reserves, releases, and the daily batch
 * stream. Matches TRD §17.2.
 */
@Controller('balances')
export class BalancesController {
  constructor(
    private readonly balances: BalanceStore,
    private readonly employees: EmployeeStore,
    private readonly service: BalanceService,
  ) {}

  @Get(':employeeId/:locationId/:leaveTypeId')
  fetch(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Param('leaveTypeId') leaveTypeId: string,
  ) {
    if (!this.employees.find(employeeId)) {
      throw new HcmHttpError(404, 'EMPLOYEE_NOT_FOUND', `Unknown employee ${employeeId}.`);
    }
    const balance = this.balances.find(employeeId, locationId, leaveTypeId);
    if (!balance) {
      throw new HcmHttpError(
        404,
        'INVALID_DIMENSION',
        `No balance configured for (${employeeId}, ${locationId}, ${leaveTypeId}).`,
      );
    }
    return {
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      leaveTypeId: balance.leaveTypeId,
      available: balance.available.toFixed(),
      hcmVersion: balance.hcmVersion.toString(),
      appliedAt: balance.appliedAt,
    };
  }

  @Post('reserve')
  @HttpCode(200)
  reserve(
    @Body(new ZodPipe(MutationBodySchema)) body: z.output<typeof MutationBodySchema>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.dispatch('reserve', body, idempotencyKey);
  }

  @Post('release')
  @HttpCode(200)
  release(
    @Body(new ZodPipe(MutationBodySchema)) body: z.output<typeof MutationBodySchema>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.dispatch('release', body, idempotencyKey);
  }

  /**
   * NDJSON balance dump (TRD §10.2, §17.2). The entire corpus streams in a
   * single batch; cursor-based pagination is not yet implemented.
   */
  @Get('batch')
  batch(@Res() res: Response): void {
    res.setHeader('Content-Type', 'application/x-ndjson');
    for (const row of this.balances.listAll()) {
      res.write(
        JSON.stringify({
          employeeId: row.employeeId,
          locationId: row.locationId,
          leaveTypeId: row.leaveTypeId,
          available: row.available.toFixed(),
          hcmVersion: row.hcmVersion.toString(),
          appliedAt: row.appliedAt,
        }) + '\n',
      );
    }
    res.end();
  }

  private dispatch(
    op: 'reserve' | 'release',
    body: z.output<typeof MutationBodySchema>,
    idempotencyKey: string | undefined,
  ): unknown {
    if (!idempotencyKey) {
      throw new HcmHttpError(
        400,
        'MISSING_IDEMPOTENCY_KEY',
        'Reserve/release MUST be invoked with an `Idempotency-Key` header.',
      );
    }
    let units;
    try {
      units = parseDecimal(body.units);
    } catch (err) {
      throw new HcmHttpError(400, 'INVALID_UNITS', (err as Error).message);
    }
    const outcome =
      op === 'reserve'
        ? this.service.reserve({ ...body, units, idempotencyKey })
        : this.service.release({ ...body, units, idempotencyKey });
    if (outcome.kind === 'REJECTED') {
      // Surface as HcmHttpError so Nest's exception filter renders the
      // canonical `{error, message}` shape with the correct status.
      throw new HcmHttpError(outcome.statusCode, outcome.body.error, outcome.body.message);
    }
    return outcome.body;
  }
}
