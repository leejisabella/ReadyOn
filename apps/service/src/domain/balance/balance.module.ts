import { Module } from '@nestjs/common';
import { BalanceService } from './balance.service';
import { BalanceStore } from './balance.store';

/**
 * Owns the local balance projection: `available` from HCM plus the three
 * hold buckets the saga manipulates. The store is a thin prepared-statement
 * wrapper; the service holds the state-machine logic and the transactional
 * read-modify-write semantics.
 *
 * @ref docs/04_Module_Plan.md §3.3
 */
@Module({
  providers: [BalanceStore, BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
