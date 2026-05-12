import { z } from 'zod';
import type { ServiceConfig } from './service-config';

/**
 * Mapping from environment variable names to {@link ServiceConfig} fields.
 *
 * Conventions:
 *  - SCREAMING_SNAKE_CASE on env keys; the schema converts strings to the
 *    typed values the rest of the service expects.
 *  - Every knob has a default sourced from TRD §16; production deployments
 *    only need to override what differs from the spec.
 *  - `loadConfig` throws a `ZodError` on invalid input — we fail fast at
 *    startup rather than letting a misconfigured worker run.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const positiveInt = z.coerce.number().int().positive();

const EnvSchema = z
  .object({
    PORT: positiveInt.default(3000),
    DB_PATH: z.string().min(1).default('./time-off.db'),

    HCM_BASE_URL: z.string().url(),
    HCM_TIMEOUT_MS: positiveInt.default(5_000),
    HCM_UNHEALTHY_AFTER_FAILURES: positiveInt.default(3),
    HCM_HEALTHY_AFTER_MS: positiveInt.default(MINUTE_MS),

    BREAK_GLASS_MIN_OUTAGE_MS: positiveInt.default(MINUTE_MS),
    BREAK_GLASS_REQUIRE_ROLE: z
      .enum(['employee', 'manager', 'break_glass_approver', 'hr_admin'])
      .default('break_glass_approver'),

    RECONCILER_HISTORY_QUERY_WINDOW_MS: positiveInt.default(24 * HOUR_MS),
    RECONCILER_STALE_AFTER_MS: positiveInt.default(4 * HOUR_MS),
    RECONCILER_LEASE_TTL_MS: positiveInt.default(MINUTE_MS),

    RECONCILIATION_STALE_BALANCE_THRESHOLD_MS: positiveInt.default(5 * MINUTE_MS),

    CANCELLATION_PENDING_ALERT_THRESHOLD_MS: positiveInt.default(HOUR_MS),
  });
// Unknown keys (PATH, HOME, every other env var) are silently dropped —
// the schema is a typed view onto `process.env`, not a guard against it.

export type EnvShape = z.input<typeof EnvSchema>;

/**
 * Parse a raw env-vars record into a typed {@link ServiceConfig}. Throws a
 * Zod validation error on misconfiguration — callers (entry points + tests)
 * decide whether to crash or surface a human-friendly message.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const parsed = EnvSchema.parse(env);
  return {
    server: { port: parsed.PORT, dbPath: parsed.DB_PATH },
    hcm: {
      baseUrl: parsed.HCM_BASE_URL,
      timeoutMs: parsed.HCM_TIMEOUT_MS,
      unhealthyAfterFailures: parsed.HCM_UNHEALTHY_AFTER_FAILURES,
      healthyAfterMs: parsed.HCM_HEALTHY_AFTER_MS,
    },
    breakGlass: {
      minOutageMs: parsed.BREAK_GLASS_MIN_OUTAGE_MS,
      requireRole: parsed.BREAK_GLASS_REQUIRE_ROLE,
    },
    reconciler: {
      historyQueryWindowMs: parsed.RECONCILER_HISTORY_QUERY_WINDOW_MS,
      staleAfterMs: parsed.RECONCILER_STALE_AFTER_MS,
      leaseTtlMs: parsed.RECONCILER_LEASE_TTL_MS,
    },
    reconciliation: {
      staleBalanceThresholdMs: parsed.RECONCILIATION_STALE_BALANCE_THRESHOLD_MS,
    },
    cancellation: {
      pendingAlertThresholdMs: parsed.CANCELLATION_PENDING_ALERT_THRESHOLD_MS,
    },
  };
}
