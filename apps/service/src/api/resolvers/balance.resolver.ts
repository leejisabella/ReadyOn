import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { BalanceService } from '../../domain/balance/balance.service';
import type { BalanceRow } from '../../domain/balance/balance.store';
import { BalanceType, HoldsType } from '../types/balance.type';

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
  ): BalanceType | null {
    const row = this.service.get(employeeId, locationId, leaveTypeId);
    return row === null ? null : toGraphql(row);
  }

  @Query(() => [BalanceType], {
    description: 'Every balance row known locally for an employee.',
  })
  balances(@Args('employeeId', { type: () => ID }) employeeId: string): BalanceType[] {
    return this.service.listForEmployee(employeeId).map(toGraphql);
  }
}

function toGraphql(row: BalanceRow): BalanceType {
  return {
    employeeId: row.employeeId,
    locationId: row.locationId,
    leaveTypeId: row.leaveTypeId,
    available: row.available,
    holds: row.holds as HoldsType,
    hcmVersion: row.hcmVersion.toString(),
    hcmEffectiveAt: row.hcmEffectiveAt,
    lastReconciledAt: row.lastReconciledAt,
    state: row.state as BalanceType['state'],
  };
}
