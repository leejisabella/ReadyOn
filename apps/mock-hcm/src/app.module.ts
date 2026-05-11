import { DynamicModule, Module } from '@nestjs/common';
import * as path from 'node:path';
import { AdminModule } from './admin/admin.module';
import { ApiModule } from './api/api.module';
import { DatabaseModule } from './persistence/database.module';

/**
 * Root module for the Mock HCM partner.
 *
 * Database path resolves from `MOCK_HCM_DB_PATH` env (used by tests to pick
 * `:memory:`); the default lives under `apps/mock-hcm/data/`.
 *
 * @ref docs/04_Module_Plan.md §4
 * @ref docs/01_TRD.md §17
 */
@Module({})
export class MockHcmModule {
  static forRoot(opts?: { readonly dbPath?: string }): DynamicModule {
    const dbPath = opts?.dbPath ?? resolveDefaultDbPath();
    return {
      module: MockHcmModule,
      imports: [DatabaseModule.forRoot({ dbPath }), ApiModule, AdminModule],
    };
  }
}

function resolveDefaultDbPath(): string {
  if (process.env.MOCK_HCM_DB_PATH) return process.env.MOCK_HCM_DB_PATH;
  return path.resolve(__dirname, '..', 'data', 'mock-hcm.sqlite');
}
