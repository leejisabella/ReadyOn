require('ts-node/register/transpile-only');
const base = require('./jest.config.ts').default;

// Stryker-only overrides. Suppress ts-jest diagnostics so the strict-mode
// errors that fire on Stryker's instrumented source files (synthetic
// stryNS_9fa48 reassignments, implicit `any` in helper params, etc.) don't
// abort the sandbox dry run. Type-checking still runs normally for `npm test`
// via jest.config.ts; the typescript-checker in stryker.config.json keeps
// killing mutants that produce real compile errors.
module.exports = {
  ...base,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: false }],
  },
};
