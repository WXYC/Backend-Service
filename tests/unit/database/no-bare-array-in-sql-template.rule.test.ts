/**
 * Tests for the wxyc/no-bare-array-in-sql-template ESLint rule (BS#2010).
 *
 * The rule flags a bare JS array interpolated into a **Drizzle** `sql`
 * tagged template — Drizzle splats the array across N positional
 * placeholders instead of binding a PG array, so `= ANY(${ids})` becomes
 * `= ANY(($1, $2, … $N))`, a row constructor Postgres rejects at parse time
 * (42809). This exact defect shipped to production three times under three
 * different call sites (BS#1068, BS#1071, #2007).
 *
 * Two things this suite exists to prove, per the issue's acceptance
 * criteria — not just assert, but demonstrate the rule actually catches the
 * historical shape and actually leaves the fixed shape alone:
 *
 *   1. The rule fails on `ANY(${someArray})` inside a Drizzle `sql`
 *      template, with a message naming the correct form.
 *   2. The rule does NOT fire on the identical syntax under a postgres-js
 *      tagged template (`getTestDb()`'s form in this repo's integration
 *      tests) — getting this backwards would be worse than not shipping the
 *      rule at all (see the rule's own docblock).
 *
 * The rule is type-aware (it needs to distinguish `ids: number[]`, the bug,
 * from `idArrayLiteral: string`, the fix — see the rule's docblock for why
 * a pure position/AST check can't do that without false-positiving on every
 * one of the six call sites this issue just fixed), so these tests run
 * through `@typescript-eslint/parser` with `projectService.
 * allowDefaultProject` — the same mechanism that lets a virtual, not-on-disk
 * test fixture still get real type information without needing a real
 * tsconfig.json entry for it.
 */
import path from 'path';
import { Linter, RuleTester } from 'eslint';

// Both required (not import-default'd) for the same reason: avoid any
// ESM/CJS interop ambiguity over whether the default export resolves to the
// whole module — this rule needs the REAL parser object, and a silent
// `undefined` here degrades to espree instead of failing loudly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('@typescript-eslint/parser') as { parseForESLint: unknown };

// The rule plugin lives at `eslint-rules/no-bare-array-in-sql-template.cjs`.
// The CommonJS extension is deliberate — see source-tagged-constraint.cjs's
// header comment for why (same module loads from `eslint.config.mjs` via ESM
// default-import interop, and from these ts-jest-compiled tests under CJS).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wxycLocalRules = require('../../../eslint-rules/no-bare-array-in-sql-template.cjs') as {
  rules: { 'no-bare-array-in-sql-template': unknown };
};

const rule = wxycLocalRules.rules['no-bare-array-in-sql-template'];

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
    parserOptions: {
      // Lets a `code` string that isn't backed by a real file on disk still
      // get full type information, by building a lightweight in-memory
      // "default project" for it rather than requiring an entry in a real
      // tsconfig.json. Verified working against this exact rule module by
      // hand before this suite was written (see the PR description).
      projectService: {
        allowDefaultProject: ['*.ts'],
        // typescript-eslint caps the default-project glob at 8 matching
        // files as a footgun guard against accidentally running full-project
        // type-aware linting file-by-file in a real project. This suite is
        // exactly the intended exception it names in its own error message:
        // a bounded, fixed set of virtual test-only filenames, not a real
        // glob widening in production lint config.
        maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 30,
      },
      tsconfigRootDir: path.resolve(__dirname, '../../..'),
    },
  },
});

ruleTester.run('no-bare-array-in-sql-template', rule, {
  valid: [
    // The FIXED shape at all six real call sites: intArrayLiteral(...)'s
    // return type is `string`, bound as a single param and cast in SQL.
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare function intArrayLiteral(ids: readonly number[]): string;
        declare const ids: number[];
        const idArrayLiteral = intArrayLiteral(ids);
        const q = sql\`SELECT * FROM t WHERE id = ANY(\${idArrayLiteral}::int[])\`;
      `,
      filename: 'valid-fixed-shape.ts',
    },
    // Calling intArrayLiteral(...) directly inline (no intermediate
    // variable) — also a string at the interpolation site.
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare function intArrayLiteral(ids: readonly number[]): string;
        declare const ids: number[];
        const q = sql\`SELECT * FROM t WHERE id = ANY(\${intArrayLiteral(ids)}::int[])\`;
      `,
      filename: 'valid-inline-call.ts',
    },
    // A scalar interpolation — nothing array-shaped at all.
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare const id: number;
        const q = sql\`SELECT * FROM t WHERE id = \${id}\`;
      `,
      filename: 'valid-scalar.ts',
    },
    // THE critical negative case: identical `ANY(${array})` syntax, but the
    // tag resolves to a LOCAL variable (a postgres-js client, e.g.
    // `getTestDb()`'s return value in this repo's integration tests) rather
    // than an import from 'drizzle-orm'. This form is CORRECT under
    // postgres-js — postgres-js binds a JS array as a genuine PG array — so
    // the rule must not flag it. Getting this backwards is explicitly the
    // failure mode the rule's docblock calls "worse than not shipping it".
    {
      code: `
        declare function getTestDb(): (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
        const sql = getTestDb();
        declare const ids: number[];
        const q = sql\`SELECT * FROM t WHERE id = ANY(\${ids})\`;
      `,
      filename: 'valid-postgres-js-not-flagged.ts',
    },
  ],

  invalid: [
    // The exact historical shape (BS#1068 / BS#1071 / #2007): a bare
    // `number[]` interpolated directly inside `ANY(...)` in a Drizzle `sql`
    // template.
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare const ids: number[];
        const q = sql\`SELECT * FROM t WHERE id = ANY(\${ids})\`;
      `,
      filename: 'invalid-any-bare-array.ts',
      errors: [{ messageId: 'bareArrayInSqlTemplate' }],
    },
    // The same bug with an (also broken — BS#1068) explicit cast attached
    // to the bare interpolation. The cast doesn't fix the splat.
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare const ids: number[];
        const q = sql\`SELECT * FROM t WHERE id = ANY(\${ids}::int[])\`;
      `,
      filename: 'invalid-any-bare-array-cast.ts',
      errors: [{ messageId: 'bareArrayInSqlTemplate' }],
    },
    // Broader net than "just inside ANY(...)": a bare array interpolated
    // anywhere in a Drizzle `sql` template is wrong, because Drizzle has no
    // API that treats a raw interpolated array as anything other than a
    // positional splat. This is the "ideally any ${} whose static type is
    // an array" half of the issue, not just the narrower "at minimum inside
    // ANY(...)" half.
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare const ids: number[];
        const q = sql\`SELECT * FROM t WHERE x IN (\${ids})\`;
      `,
      filename: 'invalid-in-not-any.ts',
      errors: [{ messageId: 'bareArrayInSqlTemplate' }],
    },
    // A `readonly number[]` — the same defect, just with a readonly array
    // type (the exact parameter type `intArrayLiteral` itself declares).
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare const ids: readonly number[];
        const q = sql\`SELECT * FROM t WHERE id = ANY(\${ids})\`;
      `,
      filename: 'invalid-readonly-array.ts',
      errors: [{ messageId: 'bareArrayInSqlTemplate' }],
    },
    // A bare TEXT array — the trap isn't integer-specific; a `string[]`
    // splats exactly the same way.
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare const names: string[];
        const q = sql\`SELECT * FROM t WHERE name IN (\${names})\`;
      `,
      filename: 'invalid-text-array.ts',
      errors: [{ messageId: 'bareArrayInSqlTemplate' }],
    },
    // Aliased import — `import { sql as dsql }` still resolves through
    // scope analysis to the drizzle-orm `sql` binding.
    {
      code: `
        import { sql as dsql } from 'drizzle-orm';
        declare const ids: number[];
        const q = dsql\`SELECT * FROM t WHERE id = ANY(\${ids})\`;
      `,
      filename: 'invalid-aliased-import.ts',
      errors: [{ messageId: 'bareArrayInSqlTemplate' }],
    },
    // Two bad interpolations in one template — one report each.
    {
      code: `
        import { sql } from 'drizzle-orm';
        declare const ids: number[];
        declare const otherIds: number[];
        const q = sql\`SELECT * FROM t WHERE id = ANY(\${ids}) OR other_id = ANY(\${otherIds})\`;
      `,
      filename: 'invalid-two-bad-interpolations.ts',
      errors: [{ messageId: 'bareArrayInSqlTemplate' }, { messageId: 'bareArrayInSqlTemplate' }],
    },
  ],
});

/**
 * Known gaps (see the rule's own docblock, "## Known gaps"): shapes that
 * escape `isDrizzleSqlTag`'s scope-analysis check today, with zero live
 * call sites in this codebase. These do NOT belong in `RuleTester`'s
 * `valid` array above — a `valid` case reads as "this is intentionally
 * fine," and a real bug shape that the rule happens to miss is the
 * opposite of fine. This block exercises gap #4 (a namespace import used
 * as a member-expression tag) directly against `eslint.Linter` so the
 * miss is asserted AND labeled as a miss, not asserted as correct
 * behavior. Gaps #1-3 (re-export through an intermediate module, `sql`
 * passed as a function parameter, and a hypothetical `drizzle-orm`
 * subpath import) are documented in the rule's docblock but have no
 * dedicated fixture here — none has ever appeared in this codebase either,
 * and constructing a realistic one for each is lower value than fixing the
 * gaps outright would be, which is out of scope for this change.
 */
describe('no-bare-array-in-sql-template — known gaps (documented misses, not intended behavior)', () => {
  it('gap #4: does NOT catch a bare array in ANY(...) tagged via a namespace-import member expression (drizzle.sql`...`)', () => {
    const linter = new Linter({ configType: 'flat' });
    const messages = linter.verify(
      `
        import * as drizzle from 'drizzle-orm';
        declare const ids: number[];
        const q = drizzle.sql\`SELECT * FROM t WHERE id = ANY(\${ids})\`;
      `,
      [
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tsParser,
            parserOptions: {
              projectService: {
                allowDefaultProject: ['*.ts'],
                maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 30,
              },
              tsconfigRootDir: path.resolve(__dirname, '../../..'),
            },
            sourceType: 'module',
          },
          plugins: { wxyc: wxycLocalRules },
          rules: { 'wxyc/no-bare-array-in-sql-template': 'error' },
        },
      ],
      { filename: 'known-gap-namespace-import.ts' }
    );

    // This IS the actual historical bug shape (BS#1068/BS#1071/#2007
    // family) — it would 42809 in production exactly like the other
    // `invalid` cases above. The rule currently can't see it because
    // `isDrizzleSqlTag` only handles a bare Identifier tag, not a
    // MemberExpression. Asserting `toHaveLength(0)` here documents the gap
    // as a gap: if a future change to `isDrizzleSqlTag` starts catching
    // this shape, this assertion breaks and should be updated to `invalid`
    // — a welcome failure, not a regression.
    expect(messages).toHaveLength(0);
  });
});
