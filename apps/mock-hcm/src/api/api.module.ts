import { Module } from '@nestjs/common';
import { BalanceService } from './balance.service';
import { BalancesController } from './balances.controller';
import { EmployeesController } from './employees.controller';
import { EmploymentController } from './employment.controller';
import { LeaveTypesController } from './leave-types.controller';
import { TransactionsController } from './transactions.controller';

/** HCM-shaped public HTTP API (TRD §17.2). */
@Module({
  providers: [BalanceService],
  controllers: [
    BalancesController,
    EmployeesController,
    EmploymentController,
    LeaveTypesController,
    TransactionsController,
  ],
})
export class ApiModule {}
