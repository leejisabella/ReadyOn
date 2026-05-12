import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { BalanceService } from '../../domain/balance/balance.service';
import type { BalanceRow } from '../../domain/balance/balance.store';
import { BalanceType } from '../types/balance.type';

@Resolver(() => BalanceType)
export class BalanceResolver {
  constructor(private readonly service: BalanceService) {}

  @Query(() => BalanceType, {
    nullable: true,
    description: 'Balance for a single (employee, location, leaveType).',
  })
  balance(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('locationId', { type: () => ID }) locationId: string,
    @Args('leaveTypeId', { type: () => ID }) leaveTypeId: string,
  ): BalanceView | null {
    const row = this.service.get(employeeId, locationId, leaveTypeId);
    return row === null ? null : toView(row);
  }

  @Query(() => [BalanceType], {
    description: 'Every balance row known locally for an employee.',
  })
  balances(@Args('employeeId', { type: () => ID }) employeeId: string): BalanceView[] {
    return this.service.listForEmployee(employeeId).map(toView);
  }
}

/**
 * Domain `BalanceRow.hcmVersion` is a `bigint` (lossless integer comparisons);
 * the schema expects a string (TRD §13 — bigints don't survive JSON). The
 * mapper does the conversion at the resolver boundary so the rest of the
 * pipeline keeps using `bigint` for math.
 */
interface BalanceView extends Omit<BalanceRow, 'hcmVersion'> {
  readonly hcmVersion: string;
}

function toView(row: BalanceRow): BalanceView {
  return { ...row, hcmVersion: row.hcmVersion.toString() };
}
