import { DynamicModule, Module } from '@nestjs/common';
import { ApiModule } from './api/api.module';
import { HcmAdapterModule } from './infrastructure/hcm/hcm-adapter.module';
import { DatabaseModule } from './infrastructure/persistence/database.module';

export interface AppModuleOptions {
  readonly dbPath: string;
  readonly hcmBaseUrl: string;
  readonly hcmTimeoutMs?: number;
  readonly breakGlassMinOutageMs?: number;
}

/**
 * Root module of the ReadyOn Time-Off service.
 *
 * Wires every feature module per Module Plan §2:
 *   Database → HCM adapter → ApiModule (which composes every domain module).
 *
 * @ref docs/04_Module_Plan.md §2
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot({ dbPath: options.dbPath }),
        HcmAdapterModule.forRoot({
          adapter: {
            baseUrl: options.hcmBaseUrl,
            timeoutMs: options.hcmTimeoutMs ?? 5_000,
          },
        }),
        ApiModule.forRoot({
          request: {
            breakGlass: { minOutageMs: options.breakGlassMinOutageMs ?? 60_000 },
          },
        }),
      ],
    };
  }
}
