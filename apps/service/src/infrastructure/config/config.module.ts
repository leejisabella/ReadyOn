import { DynamicModule, Module } from '@nestjs/common';
import { SERVICE_CONFIG, type ServiceConfig } from './service-config';

/**
 * Provides {@link ServiceConfig} under the {@link SERVICE_CONFIG} token.
 * Registered globally so any module/service can inject the config without
 * being threaded through every parent's `.forRoot`.
 *
 * @ref docs/01_TRD.md §16
 */
@Module({})
export class ConfigModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: SERVICE_CONFIG, useValue: config }],
      exports: [SERVICE_CONFIG],
    };
  }
}
