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
 * `Number.isSafeInteger`; anything that fails throws instead of being
 * spliced into the literal as raw SQL text. This is a genuine runtime
 * check, not the "safe by construction because the caller's type is
 * `number[]`" claim the six inline copies this helper replaces used to
 * carry — that claim wasn't true: the arrays typically arrive via an
 * unchecked `as unknown as` cast over raw driver output (`db.execute(...)
 * as unknown as Array<{ id: number }>`), with nothing enforcing the cast at
 * runtime. A numeric STRING element within the safe-integer range (e.g.
 * what postgres-js returns for a `bigint` column, as long as the value
 * fits in ±2^53-1) is accepted and normalized — `Number('7')` is a safe
 * integer. `Number.isSafeInteger` rather than the looser `Number.isInteger`
 * is deliberate: `Number('9007199254740993')` — one past
 * `Number.MAX_SAFE_INTEGER` — evaluates to `9007199254740992`, a DIFFERENT
 * integer, silently. `Number.isInteger` would accept that (it's still an
 * integer, just the wrong one); `Number.isSafeInteger` rejects it, so a
 * `bigint`/`bigserial` id outside the JS-safe range throws instead of
 * splicing a corrupted id into an UPDATE or DELETE's `WHERE` clause. No
 * `bigint`/`bigserial` column exists in this schema today, so this is
 * latent, not exercised — precisely why it needs a real check rather than
 * a comment promising one.
 *
 * A `textArrayLiteral` sibling is deliberately NOT provided here — PG
 * string escaping inside a hand-built literal is real work this
 * integer-only helper sidesteps entirely by construction (only digits,
 * `-`, and `,` can ever appear in its output). For a text array, use
 * `jobs/album-reviews-etl/link.ts`'s `textArrayLiteral` (which does that
 * escaping) or join bound per-element parameters with `sql.join(...)` (see
 * `jobs/library-etl/job.ts`'s `buildLegacySourcedSetWhere` for a live
 * example of the API in this codebase).
 */
export const intArrayLiteral = (ids: readonly number[]): string => {
  const literals = ids.map((id) => {
    // `Number(null)` is `0` and `Number([])` is `0` — both safe integers by
    // `Number.isSafeInteger`'s definition — so null/undefined must be
    // rejected explicitly before the coercion, or a missing id would
    // silently become a real one instead of failing loudly.
    if (id === null || id === undefined) {
      throw new Error(`intArrayLiteral: expected an integer, got ${JSON.stringify(id)}`);
    }
    const n = Number(id);
    // isSafeInteger, not the looser isInteger: a numeric string one past
    // Number.MAX_SAFE_INTEGER rounds to a DIFFERENT integer silently
    // (Number('9007199254740993') === 9007199254740992), which isInteger
    // would happily accept. See this function's docblock for why that
    // matters for a future bigint/bigserial column.
    if (!Number.isSafeInteger(n)) {
      throw new Error(`intArrayLiteral: expected a safe integer, got ${JSON.stringify(id)}`);
    }
    return n;
  });
  return `{${literals.join(',')}}`;
};
