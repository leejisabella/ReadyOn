import { DynamicModule, Module } from '@nestjs/common';
import { ProvisionalActionModule } from '../provisional-action/provisional-action.module';
import {
  HrReviewQueueService,
  type HrReviewQueueOptions,
} from './hr-review-queue.service';

/**
 * Read-only projection over `time_off_request` that powers the
 * `hrReviewQueue` GraphQL query (TRD §7.1). Depends on
 * {@link ProvisionalActionStore} to attach linked actions to each item.
 *
 * @ref docs/04_Module_Plan.md §3.17
 */
@Module({})
export class HrReviewQueueModule {
  static forRoot(options: HrReviewQueueOptions = {}): DynamicModule {
    return {
      module: HrReviewQueueModule,
      imports: [ProvisionalActionModule],
      providers: [
        { provide: 'HR_REVIEW_QUEUE_OPTIONS', useValue: options },
        HrReviewQueueService,
      ],
      exports: [HrReviewQueueService],
    };
  }
}
