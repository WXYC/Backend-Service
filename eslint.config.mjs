import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import prettierConfig from 'eslint-config-prettier';
import wxycSourceTaggedConstraint from './eslint-rules/source-tagged-constraint.cjs';
import wxycNoBareArrayInSqlTemplate from './eslint-rules/no-bare-array-in-sql-template.cjs';

// Both rule modules export `{ rules: { <name>: <rule> } }`; merge them into
// one `wxyc` plugin object so `files`-scoped blocks below can mix and match
// which rules apply where without re-importing per block.
const wxycLocalRules = {
  rules: {
    ...wxycSourceTaggedConstraint.rules,
    ...wxycNoBareArrayInSqlTemplate.rules,
  },
};

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/',
      '**/.cache/',
      '.claude/',
      '.worktrees/',
      '**/node_modules/',
      'coverage/',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
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

  // WXYC custom rules — schema annotations (#702)
  {
    files: ['shared/database/**/*.ts'],
    plugins: {
      wxyc: wxycLocalRules,
    },
    rules: {
      // Warn when a constraint is added to a SOURCE-tagged table. The rule is
      // intentionally a warning, not an error — it's a friction point that
      // forces an explicit acknowledgement, not a CI gate. Suppress per
      // occurrence with:
      //   // eslint-disable-next-line wxyc/source-tagged-constraint-confirmed
      // once the constraint has been confirmed consistent with the upstream's
      // data shape.
      'wxyc/source-tagged-constraint-confirmed': 'warn',
    },
  },

  // WXYC custom rules — bare-array-in-Drizzle-sql-template (BS#2010)
  //
  // Scoped everywhere a Drizzle `sql` template can appear: apps/, shared/,
  // jobs/ (the six historical call sites are all under these three), and
  // tests/ (defense in depth — a test fixture can copy the same bad shape).
  // Deliberately an ERROR, not a warn: this exact defect has shipped to
  // production three times (BS#1068, BS#1071, #2007); a warning that CI
  // doesn't fail on is exactly the "stayed writable" failure mode the
  // originating issue describes.
  {
    files: ['apps/**/*.ts', 'shared/**/*.ts', 'jobs/**/*.ts', 'tests/**/*.ts'],
    plugins: {
      wxyc: wxycLocalRules,
    },
    rules: {
      'wxyc/no-bare-array-in-sql-template': 'error',
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
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/unbound-method': 'off',
    },
  }
);
