import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/unit.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/apps/backend/$1',
    '^@wxyc/database$': '<rootDir>/shared/database/src/index.ts',
  },
  collectCoverageFrom: [
    'apps/backend/**/*.ts',
    '!**/*.d.ts',
    '!**/dist/**',
  ],
  clearMocks: true,
};

export default config;
