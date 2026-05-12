import { DynamicModule, Module, Type } from '@nestjs/common';
import { AuditEventService } from './audit-event.service';
import { AuditEventStore } from './audit-event.store';
import { CorrelationContext } from './correlation.context';
import { METRICS, NoopMetrics, type Metrics } from './metrics';

export interface ObservabilityModuleOptions {
  /**
   * Concrete {@link Metrics} implementation. Default {@link NoopMetrics} —
   * tests pass `InMemoryMetrics` to assert; production binds an OTel adapter.
   */
  readonly metrics?: Type<Metrics>;
}

/**
 * Cross-cutting infrastructure for audit logging, correlation propagation,
 * and metrics. Registered globally because every saga and worker emits.
 *
 * @ref docs/01_TRD.md §18, §19.3
 */
@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions = {}): DynamicModule {
    const metricsClass: Type<Metrics> = options.metrics ?? NoopMetrics;
    return {
      module: ObservabilityModule,
      global: true,
      providers: [
        AuditEventStore,
        AuditEventService,
        CorrelationContext,
        metricsClass,
        { provide: METRICS, useExisting: metricsClass },
      ],
      exports: [AuditEventStore, AuditEventService, CorrelationContext, METRICS, metricsClass],
    };
  }
}
