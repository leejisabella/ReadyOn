import { DynamicModule, Module } from '@nestjs/common';
import { BalanceModule } from '../../domain/balance/balance.module';
import { OutboxWorker, type OutboxWorkerOptions } from './outbox-worker.service';
import { OutboxStore } from './outbox.store';

/**
 * Outbox primitives + the dispatch worker. Domain modules enqueue via
 * {@link OutboxStore.enqueue}; the worker drains the queue against the
 * configured {@link HcmPort}.
 *
 * @ref docs/04_Module_Plan.md §3.11, §3.13
 */
@Module({})
export class OutboxModule {
  static forRoot(options: { readonly worker?: OutboxWorkerOptions } = {}): DynamicModule {
    return {
      module: OutboxModule,
      imports: [BalanceModule],
      providers: [
        { provide: 'OUTBOX_WORKER_OPTIONS', useValue: options.worker ?? {} },
        OutboxStore,
        OutboxWorker,
      ],
      exports: [OutboxStore, OutboxWorker],
    };
  }
}
