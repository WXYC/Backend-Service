import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/unit.setup.ts'],
  transform: {
    '^.+\\.[jt]sx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tests/tsconfig.json',
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!(jose|drizzle-orm|@wxyc/shared)/)'],
  moduleNameMapper: {
    // Mock workspace packages
    '^@wxyc/database$': '<rootDir>/tests/mocks/database.mock.ts',
    '^@wxyc/authentication$': '<rootDir>/tests/mocks/authentication.mock.ts',
    // @wxyc/lml-client: resolve to source so unit tests don't need a pre-built
    // dist (CI's unit-tests job doesn't run lint:prebuild before tests). Real
    // tests against the implementation use this; jest.mock(...) usages in
    // consumer-controller tests still take precedence.
    '^@wxyc/lml-client$': '<rootDir>/shared/lml-client/src/index.ts',
    // @wxyc/metadata: resolve to source for the same reason as @wxyc/lml-client.
    '^@wxyc/metadata$': '<rootDir>/shared/metadata/src/index.ts',
    // Mock database client for any path resolving to shared/database/src/client
    '^.*/shared/database/src/client(\\.js)?$': '<rootDir>/tests/mocks/database.mock.ts',
    // Mock better-auth modules (ESM-only, can't be transformed by ts-jest)
    '^better-auth/plugins/access$': '<rootDir>/tests/mocks/better-auth-access.mock.ts',
    '^better-auth/plugins/organization/access$': '<rootDir>/tests/mocks/better-auth-org-access.mock.ts',
    '^better-auth/node$': '<rootDir>/tests/mocks/better-auth-node.mock.ts',
    '^better-auth/api$': '<rootDir>/tests/mocks/better-auth-api.mock.ts',
    // Remove .js extensions from relative imports (ESM compatibility)
    '^(\\.{1,2}/.*)\\.(js)$': '$1',
  },
  // @wxyc/shared is a workspace dep installed under each workspace's node_modules
  // rather than hoisted to the root, so root-level tests (tests/**) can't resolve it
  // via standard node module resolution. List the workspace node_modules paths so jest's
  // resolver finds it.
  moduleDirectories: ['node_modules', 'apps/backend/node_modules', 'shared/authentication/node_modules'],
  collectCoverageFrom: ['apps/backend/**/*.ts', 'jobs/**/*.ts', '!**/*.d.ts', '!**/dist/**'],
  // Ignore worktree paths so Jest's haste map doesn't collide on duplicate
  // workspace `package.json` files (e.g. `@wxyc/database`, `@wxyc/lml-client`)
  // when multiple worktrees are active. Patterns are `<rootDir>`-anchored so a
  // jest run from inside a worktree (where rootDir resolves to the worktree
  // itself) doesn't accidentally exclude its own files. From the parent repo
  // these patterns match both worktree conventions; from inside a worktree,
  // siblings aren't under rootDir and therefore aren't haste-mapped anyway.
  modulePathIgnorePatterns: ['<rootDir>/.claude/worktrees/', '<rootDir>/.worktrees/'],
  clearMocks: true,
};

export default config;
