import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminController } from './admin.controller';
import { AdversarialModeInterceptor } from './adversarial-mode.interceptor';
import { ModeStore } from './mode.store';

/**
 * Admin / mode surface for tests (TRD §17.2 admin + §17.3 adversarial modes).
 * Exports {@link ModeStore} so the interceptor wired below shares state with
 * the controller. The interceptor is registered globally — every non-`/admin`
 * route is subject to mode mutations.
 */
@Module({
  controllers: [AdminController],
  providers: [
    ModeStore,
    { provide: APP_INTERCEPTOR, useClass: AdversarialModeInterceptor },
  ],
  exports: [ModeStore],
})
export class AdminModule {}
