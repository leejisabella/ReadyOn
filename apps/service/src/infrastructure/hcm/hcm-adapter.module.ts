import { DynamicModule, Module } from '@nestjs/common';
import { HcmHealthMonitor, type HcmHealthMonitorOptions } from './hcm-health.monitor';
import { MockHcmAdapter, type MockHcmAdapterOptions } from './mock-hcm.adapter';

/**
 * DI token under which the configured {@link HcmPort} implementation is
 * registered. Consumers inject by token, not by concrete class, so adapter
 * swaps (real vendor adapters in production) require no consumer changes.
 *
 * @example
 *   constructor(@Inject(HCM_PORT) private readonly hcm: HcmPort) {}
 */
export const HCM_PORT = 'HCM_PORT';

export interface HcmAdapterModuleOptions {
  readonly adapter: MockHcmAdapterOptions;
  readonly healthMonitor?: HcmHealthMonitorOptions;
}

/**
 * Wires the HCM adapter and the health monitor. The monitor is a singleton —
 * every adapter call updates it, and downstream subscribers (the provisional
 * reconciler) listen for HEALTHY↔UNHEALTHY transitions.
 *
 * Only the Mock adapter is registered today; real vendor adapters add cases
 * to a switch inside this module without touching consumers.
 *
 * @ref docs/04_Module_Plan.md §3.9, §3.10
 */
@Module({})
export class HcmAdapterModule {
  static forRoot(options: HcmAdapterModuleOptions): DynamicModule {
    return {
      module: HcmAdapterModule,
      global: true,
      providers: [
        {
          provide: HcmHealthMonitor,
          useFactory: () => new HcmHealthMonitor(options.healthMonitor ?? {}),
        },
        {
          provide: HCM_PORT,
          useFactory: (health: HcmHealthMonitor) => new MockHcmAdapter(options.adapter, health),
          inject: [HcmHealthMonitor],
        },
      ],
      exports: [HCM_PORT, HcmHealthMonitor],
    };
  }
}
