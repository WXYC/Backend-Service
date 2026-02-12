import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/unit.setup.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tests/tsconfig.json',
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!(jose|drizzle-orm)/)'],
  moduleNameMapper: {
    // Mock workspace database package
    '^@wxyc/database$': '<rootDir>/tests/mocks/database.mock.ts',
    // Mock database client for any path resolving to shared/database/src/client
    '^.*/shared/database/src/client(\\.js)?$': '<rootDir>/tests/mocks/database.mock.ts',
    // Remove .js extensions from relative imports (ESM compatibility)
    '^(\\.{1,2}/.*)\\.(js)$': '$1',
  },
  collectCoverageFrom: ['apps/backend/**/*.ts', '!**/*.d.ts', '!**/dist/**'],
  clearMocks: true,
};

export default config;
