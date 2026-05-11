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
};

export default config;
