import { Module } from '@nestjs/common';
import { EmploymentService } from './employment.service';
import { EmploymentStore } from './employment.store';

/**
 * Owns the local employment timeline projection. Consumes
 * `EMPLOYMENT_CHANGED` inbox events through {@link EmploymentService.applyHcmUpdate};
 * read-side callers use {@link EmploymentService.locationAt} during request
 * submission and revalidation.
 *
 * @ref docs/04_Module_Plan.md §3.4
 */
@Module({
  providers: [EmploymentStore, EmploymentService],
  exports: [EmploymentService],
})
export class EmploymentModule {}
