import { DynamicModule, Module } from '@nestjs/common';
import { BreakGlassAuthorizer, type BreakGlassAuthorizerOptions } from './break-glass.authorizer';

/**
 * Provides the pure {@link BreakGlassAuthorizer}. Depends only on the
 * (global) `HcmHealthMonitor`, so no module imports are needed.
 *
 * @ref docs/04_Module_Plan.md §5.6
 */
@Module({})
export class BreakGlassModule {
  static forRoot(options: BreakGlassAuthorizerOptions = {}): DynamicModule {
    return {
      module: BreakGlassModule,
      providers: [
        { provide: 'BREAK_GLASS_OPTIONS', useValue: options },
        BreakGlassAuthorizer,
      ],
      exports: [BreakGlassAuthorizer],
    };
  }
}
