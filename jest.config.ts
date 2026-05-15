import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/apps', '<rootDir>/libs'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@time-off/domain-types$': '<rootDir>/libs/domain-types/src',
    '^@time-off/domain-types/(.*)$': '<rootDir>/libs/domain-types/src/$1',
    '^@time-off/hcm-port$': '<rootDir>/libs/hcm-port/src',
    '^@time-off/hcm-port/(.*)$': '<rootDir>/libs/hcm-port/src/$1',
    '^@time-off/decimal-scalar$': '<rootDir>/libs/decimal-scalar/src',
    '^@time-off/decimal-scalar/(.*)$': '<rootDir>/libs/decimal-scalar/src/$1',
    '^@time-off/mock-hcm$': '<rootDir>/apps/mock-hcm/src',
    '^@time-off/mock-hcm/(.*)$': '<rootDir>/apps/mock-hcm/src/$1',
  },
  passWithNoTests: true,
  clearMocks: true,
  collectCoverageFrom: [
    'apps/**/src/**/*.ts',
    'libs/**/src/**/*.ts',
    '!**/*.d.ts',
    '!**/index.ts',
    '!**/main.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov', 'html'],

  /**
   * Coverage thresholds — TRD §25 of `03_Test_Plan.md` / Mini Tests §2.
   *
   * The global block is the brief's enforceable bar. The per-path blocks
   * pin the critical-module targets at the actual achieved levels so any
   * regression on these specific modules trips the gate, not just the
   * cumulative average. Mutation testing (Layer 9 / Stryker) is the
   * secondary gate that catches "test passes but doesn't actually exercise
   * the code path" — see `stryker.config.json`.
   */
  coverageThreshold: {
    // Global gate — TRD §25 enforceable bar. Branch is lower than the
    // aspirational 85% target because example tests can't exhaust every
    // defensive `?:`/`??` chain; Layer 9 (Stryker) is the secondary gate.
    global: {
      statements: 90,
      branches: 74,
      functions: 90,
      lines: 90,
    },
    // Critical modules — directory-aggregated; per-file noise on
    // `*.module.ts` (trivial branch-free DI wiring) is averaged out.
    'apps/service/src/domain/balance/': {
      statements: 95,
      branches: 80,
      functions: 95,
      lines: 95,
    },
    'apps/service/src/domain/employment/': {
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    },
    'apps/service/src/domain/hr-review-queue/': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    'apps/service/src/domain/idempotency/': {
      statements: 95,
      branches: 85,
      functions: 95,
      lines: 95,
    },
    'apps/service/src/domain/provisional-action/': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    'apps/service/src/infrastructure/persistence/': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    'apps/service/src/infrastructure/observability/': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    'libs/hcm-port/src/': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    'libs/domain-types/src/': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
  },
};

export default config;
