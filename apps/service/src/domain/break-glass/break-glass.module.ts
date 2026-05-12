import { DynamicModule, Module } from '@nestjs/common';
import { BreakGlassAuthorizer, type BreakGlassAuthorizerOptions } from './break-glass.authorizer';

/**
 * Provides the pure {@link BreakGlassAuthorizer}. Depends only on the
 * (global) `HcmHealthMonitor`, so no module imports are needed.
 *
 * Registered with `global: true` — the authorizer's options are fixed for
 * the process and we want a single instance visible to every consumer
 * (RequestService, the HcmHealth resolver, etc.) without each module
 * having to re-import this one.
 *
 * @ref docs/04_Module_Plan.md §5.6
 */
@Module({})
export class BreakGlassModule {
  static forRoot(options: BreakGlassAuthorizerOptions = {}): DynamicModule {
    return {
      module: BreakGlassModule,
      global: true,
      providers: [
        { provide: 'BREAK_GLASS_OPTIONS', useValue: options },
        BreakGlassAuthorizer,
      ],
      exports: [BreakGlassAuthorizer],
    };
  }
}
