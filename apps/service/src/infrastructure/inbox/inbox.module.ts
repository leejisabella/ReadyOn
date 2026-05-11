import { DynamicModule, Module } from '@nestjs/common';
import { BalanceModule } from '../../domain/balance/balance.module';
import { EmployeeBootstrapModule } from '../../domain/employee-bootstrap/employee-bootstrap.module';
import { EmploymentModule } from '../../domain/employment/employment.module';
import { LeaveTypeAvailabilityModule } from '../../domain/leave-type-availability/leave-type-availability.module';
import { InboxProcessor, type InboxProcessorOptions } from './inbox-processor.service';
import { InboxStore } from './inbox.store';
import { INBOX_SECRET, WebhookController } from './webhook.controller';

export interface InboxModuleOptions {
  readonly webhookSecret: string;
  readonly processor?: InboxProcessorOptions;
}

/**
 * Inbound side: HTTP webhook → store → processor → domain projection.
 *
 * Wire by passing the webhook shared secret + processor knobs to
 * `forRoot`. The secret comes from configuration in production; tests can
 * use any string.
 *
 * @ref docs/04_Module_Plan.md §3.12, §3.14
 */
@Module({})
export class InboxModule {
  static forRoot(options: InboxModuleOptions): DynamicModule {
    return {
      module: InboxModule,
      imports: [
        BalanceModule,
        EmploymentModule,
        LeaveTypeAvailabilityModule,
        EmployeeBootstrapModule,
      ],
      providers: [
        { provide: INBOX_SECRET, useValue: options.webhookSecret },
        { provide: 'INBOX_PROCESSOR_OPTIONS', useValue: options.processor ?? {} },
        InboxStore,
        InboxProcessor,
      ],
      controllers: [WebhookController],
      exports: [InboxStore, InboxProcessor],
    };
  }
}
