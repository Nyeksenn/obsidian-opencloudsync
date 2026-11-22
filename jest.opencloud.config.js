/** @type {import('jest').Config} */
// [opencloud-fork] Live OpenCloud layer: real OpenCloud server (compose.yml), no UI. Runs ONLY via `pnpm test:oc`
// (tests/opencloud-live/run.sh starts/prepares the server and passes the credentials); excluded from `pnpm test`.
// It reuses upstream's live `obsidian` mock (Node fetch) and in-memory FakeVault from tests/b1-nextcloud-headless/.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/opencloud-live/setup.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/b1-nextcloud-headless/__mocks__/obsidian.ts',
  },
  testMatch: ['**/tests/opencloud-live/**/*.oc.test.ts'],
  // Scoped like the b1 config, so the "a" suite's support/obsidian.ts is not a duplicate haste mock.
  roots: ['<rootDir>/src', '<rootDir>/tests/opencloud-live'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  testTimeout: 120000,
  // One server, shared space: run files one after another so their request load stays predictable.
  maxWorkers: 1,
};
