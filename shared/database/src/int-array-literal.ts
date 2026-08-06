/**
 * Build a Postgres array-literal string (`'{1,2,3}'`) for a numeric-id list,
 * for binding into a `sql\`… = ANY(${idArrayLiteral}::int[])\`` predicate
 * (BS#2010).
 *
 * ## Why this exists
 *
 * Interpolating a bare JS array into a **Drizzle** `sql` template does not
 * bind a PG array — it splats the array across N positional placeholders,
 * turning `= ANY(${ids})` into `= ANY(($1, $2, … $N))`, a row constructor.
 * Postgres rejects that at parse time (SQLSTATE 42809, "op ANY/ALL (array)
 * requires array on right side"). This exact defect has shipped to
 * production three times under different call sites (BS#1068, BS#1071,
 * #2007) — each was patched with another private copy of this same
 * work-around instead of a shared, hardened helper, which is what kept the
 * defective bare-array form writable everywhere else.
 *
 * The work-around: bind ONE string parameter shaped as a PG array literal
 * and cast it in SQL (`::int[]`). Postgres parses the cast, not Drizzle's
 * splat, so this survives at any arity, including zero and one (the arities
 * that happen to work by accident with the splat, which is what makes the
 * bug easy to miss in a small manual test).
 *
 * ## The two-client trap
 *
 * The identical `= ANY(${ids})` syntax is CORRECT under a raw postgres-js
 * tagged template (`postgres-js`'s own `sql\`…\`` — e.g. `getTestDb()` in
 * this repo's integration tests) — postgres-js binds a JS array as a
 * genuine PG array there. Both clients are used in this codebase, so the
 * same source line is right in one file and wrong in another with no
 * visible difference. Use this helper only inside a Drizzle `sql` template
 * (`import { sql } from 'drizzle-orm'`); do not "simplify" a postgres-js
 * `ANY(${array})` call site to use it — that call site is already correct.
 *
 * The `no-bare-array-in-sql-template` ESLint rule (`eslint-rules/`) flags a
 * bare array interpolated into a Drizzle `sql` template and names this
 * helper as the fix; see `docs/bulk-update-playbook.md`.
 *
 * ## What this validates
 *
 * Every element is round-tripped through `Number(...)` and checked with
 * `Number.isInteger`; a non-integer element throws instead of being spliced
 * into the literal as raw SQL text. This is a genuine runtime check, not the
 * "safe by construction because the caller's type is `number[]`" claim the
 * six inline copies this helper replaces used to carry — that claim wasn't
 * true: the arrays typically arrive via an unchecked `as unknown as` cast
 * over raw driver output (`db.execute(...) as unknown as Array<{ id:
 * number }>`), with nothing enforcing the cast at runtime. A numeric STRING
 * element (e.g. what postgres-js returns for a `bigint` column) is accepted
 * and normalized — `Number('7')` is a valid integer — so this helper keeps
 * working the day a column widens from `integer` to `bigint`; anything that
 * isn't a clean integer (`NaN`, `Infinity`, a non-numeric string, `null`,
 * `undefined`) throws rather than producing malformed or injectable SQL.
 *
 * A `textArrayLiteral` sibling is deliberately NOT provided — PG string
 * escaping inside a hand-built literal is real work this integer-only
 * helper sidesteps entirely by construction (only digits, `-`, and `,` can
 * ever appear in its output). The honest answer for a text array is a
 * `sql.join(...)`-built `VALUES` list; see `jobs/album-reviews-etl/link.ts`
 * for the pattern PR #2008 generalized this from.
 */
export const intArrayLiteral = (ids: readonly number[]): string => {
  const literals = ids.map((id) => {
    // `Number(null)` is `0` and `Number([])` is `0` — both integers by
    // `Number.isInteger`'s definition — so null/undefined must be rejected
    // explicitly before the coercion, or a missing id would silently become
    // a real one instead of failing loudly.
    if (id === null || id === undefined) {
      throw new Error(`intArrayLiteral: expected an integer, got ${JSON.stringify(id)}`);
    }
    const n = Number(id);
    if (!Number.isInteger(n)) {
      throw new Error(`intArrayLiteral: expected an integer, got ${JSON.stringify(id)}`);
    }
    return n;
  });
  return `{${literals.join(',')}}`;
};
