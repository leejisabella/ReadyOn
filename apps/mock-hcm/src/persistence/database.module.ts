import { DynamicModule, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { createMockHcmDatabase, type Database } from './database';
import { DATABASE } from './database.token';
import { runMigrations } from './migrations';

import { BalanceStore } from './balance.store';
import { EmployeeStore } from './employee.store';
import { EmploymentStore } from './employment.store';
import { LeaveTypeStore } from './leave-type.store';
import { TransactionStore } from './transaction.store';
import { VersionStore } from './version.store';

const STORES = [
  VersionStore,
  EmployeeStore,
  EmploymentStore,
  LeaveTypeStore,
  BalanceStore,
  TransactionStore,
] as const;

/**
 * DI module that opens the SQLite handle, runs migrations on construct, and
 * closes the handle on application shutdown. Exports every store so feature
 * modules need only one import.
 */
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  static forRoot(opts: { readonly dbPath: string }): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: DATABASE,
          useFactory: () => {
            const db = createMockHcmDatabase(opts.dbPath);
            runMigrations(db);
            return db;
          },
        },
        ...STORES,
      ],
      exports: [DATABASE, ...STORES],
    };
  }

  onApplicationShutdown(): void {
    if (this.db.open) this.db.close();
  }
}
