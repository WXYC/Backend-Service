import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/unit.setup.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tests/tsconfig.json',
    }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(jose|drizzle-orm)/)',
  ],
  moduleNameMapper: {
    '^jose$': '<rootDir>/tests/__mocks__/jose.ts',
    '^drizzle-orm$': '<rootDir>/tests/__mocks__/drizzle-orm.ts',
    '^@/(.*)\.js$': '<rootDir>/apps/backend/$1.ts',
    '^@/(.*)$': '<rootDir>/apps/backend/$1.ts',
    '^@wxyc/database$': '<rootDir>/tests/mocks/database.mock.ts',
    '^(\\.{1,2}/.*)\\.(js)$': '$1',
  },
  collectCoverageFrom: [
    'apps/backend/**/*.ts',
    '!**/*.d.ts',
    '!**/dist/**',
  ],
  clearMocks: true,
};

export default config;
