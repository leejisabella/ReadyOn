import { Module } from '@nestjs/common';

/**
 * Mock HCM application module.
 *
 * Owns the HCM-shaped public API (balances, employment, leave types, transactions),
 * the admin surface used by tests via MockHcmTestHarness, the adversarial mode
 * controller, and the outbound webhook emitter. Backed by a separate SQLite
 * database so crash-recovery tests can verify post-state across service restarts.
 *
 * @ref docs/04_Module_Plan.md §4
 * @ref docs/01_TRD.md §17
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class MockHcmModule {}
