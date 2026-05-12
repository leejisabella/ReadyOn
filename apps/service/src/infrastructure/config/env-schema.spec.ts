import { ZodError } from 'zod';
import { loadConfig } from './env-schema';

/** Minimum env for parsing to succeed — all the un-defaulted fields. */
const MIN_ENV = { HCM_BASE_URL: 'http://hcm.example' } as const;

describe('loadConfig', () => {
  it('returns the full TRD §16 default surface when only required fields are set', () => {
    expect(loadConfig({ ...MIN_ENV })).toEqual({
      server: { port: 3000, dbPath: './time-off.db' },
      hcm: {
        baseUrl: 'http://hcm.example',
        timeoutMs: 5_000,
        unhealthyAfterFailures: 3,
        healthyAfterMs: 60_000,
      },
      breakGlass: {
        minOutageMs: 60_000,
        requireRole: 'break_glass_approver',
      },
      reconciler: {
        historyQueryWindowMs: 24 * 60 * 60 * 1_000,
        staleAfterMs: 4 * 60 * 60 * 1_000,
        leaseTtlMs: 60_000,
      },
      reconciliation: { staleBalanceThresholdMs: 5 * 60 * 1_000 },
      cancellation: { pendingAlertThresholdMs: 60 * 60 * 1_000 },
    });
  });

  it('coerces numeric envs from strings (process.env values are always strings)', () => {
    const config = loadConfig({
      ...MIN_ENV,
      PORT: '8080',
      HCM_TIMEOUT_MS: '2500',
      BREAK_GLASS_MIN_OUTAGE_MS: '120000',
    });
    expect(config.server.port).toBe(8080);
    expect(config.hcm.timeoutMs).toBe(2500);
    expect(config.breakGlass.minOutageMs).toBe(120_000);
  });

  it('honours the break-glass role override when valid', () => {
    const config = loadConfig({ ...MIN_ENV, BREAK_GLASS_REQUIRE_ROLE: 'hr_admin' });
    expect(config.breakGlass.requireRole).toBe('hr_admin');
  });

  it('throws ZodError when HCM_BASE_URL is missing — fail-fast at boot', () => {
    expect(() => loadConfig({})).toThrow(ZodError);
  });

  it('throws ZodError when HCM_BASE_URL is not a URL', () => {
    expect(() => loadConfig({ HCM_BASE_URL: 'not a url' })).toThrow(ZodError);
  });

  it('throws ZodError when a numeric env is zero or negative', () => {
    expect(() => loadConfig({ ...MIN_ENV, PORT: '0' })).toThrow(ZodError);
    expect(() => loadConfig({ ...MIN_ENV, HCM_TIMEOUT_MS: '-1' })).toThrow(ZodError);
  });

  it('throws ZodError when BREAK_GLASS_REQUIRE_ROLE is an unknown role', () => {
    expect(() => loadConfig({ ...MIN_ENV, BREAK_GLASS_REQUIRE_ROLE: 'janitor' })).toThrow(
      ZodError,
    );
  });

  it('ignores unrelated env vars (PATH, HOME, etc.) without erroring', () => {
    expect(() =>
      loadConfig({ ...MIN_ENV, PATH: '/usr/bin', HOME: '/root', RANDOM_UNRELATED: 'x' }),
    ).not.toThrow();
  });
});
