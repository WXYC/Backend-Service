import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      'coverage/',
      '**/*.js',
      '**/*.mjs',
      '**/*.d.ts',
      '**/*.d.mts',
      'shared/database/src/migrations/**',
      'dev_env/**',
      'scripts/**',
      'drizzle.config.ts',
      'jest.unit.config.ts',
      'jest.config.json',
      'jest.parallel.config.json',
      '**/tsup.config.ts',
    ],
  },

  // Base recommended rules
  eslint.configs.recommended,

  // TypeScript type-checked rules
  ...tseslint.configs.recommendedTypeChecked,

  // Security rules
  security.configs.recommended,

  // Prettier compat (disables formatting rules)
  prettierConfig,

  // TypeScript project config
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // App and shared code rules
  {
    files: ['apps/**/*.ts', 'shared/**/*.ts'],
    rules: {
      // Async safety (critical for Express handlers)
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Type safety (warn tier for gradual cleanup)
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // Downgrade to warn for existing code patterns
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/unbound-method': 'warn',

      // Unused vars (respect _prefix convention)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

      // Security (disable noisy rules)
      'security/detect-object-injection': 'off',

      // Server-side code
      'no-console': 'off',
    },
  },

  // Relaxed rules for tests
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  }
);
