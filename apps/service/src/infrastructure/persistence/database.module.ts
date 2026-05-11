import { DynamicModule, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { applyAppendOnlyTriggers } from './append-only-triggers';
import { createServiceDatabase, type Database } from './database';
import { DATABASE } from './database.token';
import { runMigrations } from './migrations';

export interface DatabaseModuleOptions {
  readonly dbPath: string;
  /**
   * Enable belt-and-suspenders triggers that block off-allow-list updates to
   * `provisional_action` and any mutation of `reconciliation_step`. The
   * repository layer is the primary enforcement (ADR-019); these triggers
   * exist for compliance contexts that want database-level guarantees.
   */
  readonly appendOnlyTriggers?: boolean;
}

/**
 * Provides the shared SQLite handle. Runs migrations on `forRoot` and closes
 * the handle on application shutdown.
 *
 * @ref docs/04_Module_Plan.md §3.17 (configuration)
 */
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: DATABASE,
          useFactory: () => {
            const db = createServiceDatabase(options.dbPath);
            runMigrations(db);
            if (options.appendOnlyTriggers === true) {
              applyAppendOnlyTriggers(db);
            }
            return db;
          },
        },
      ],
      exports: [DATABASE],
    };
  }

  onApplicationShutdown(): void {
    if (this.db.open) this.db.close();
  }
}
