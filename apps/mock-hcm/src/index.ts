/**
 * Public exports for `@time-off/mock-hcm`.
 *
 * Consumed by `apps/service`'s test code (via {@link MockHcmTestHarness}) to
 * boot the mock in-process. Production deployments boot via `main.ts` instead.
 */
export { MockHcmModule } from './app.module';
