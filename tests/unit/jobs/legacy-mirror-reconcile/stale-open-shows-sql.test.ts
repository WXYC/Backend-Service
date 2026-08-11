/**
 * Genuine-rendered-SQL pin for the BS#2065/#2068 stale-open-show detector's
 * final selection bound (BS#2098 review item 4 — rewrite of the BS#2069
 * review finding 1/2 call-shape test this file used to contain).
 *
 * THE BUG THIS PINS: `and(...)` wraps its own children COLLECTIVELY in one
 * pair of parentheses; it does not parenthesize each child individually. The
 * shipped-then-caught defect built the `show_end`-marker carve-out as:
 *
 *   and(bound1, bound2, bound3, bound4,
 *     sql`(${shows.id} IS DISTINCT FROM ${latestShowId}) OR (${newestEntryType} = 'show_end')`)
 *
 * — a single raw-sql fragment as `and()`'s fifth argument, never touching
 * `or()` at all, with the `'show_end'` literal typed directly into the
 * template rather than passed as a bound value. Because that fragment is ONE
 * argument to `and(...)`, not two arguments to `or(...)`, the literal ` OR `
 * renders (in real Postgres) at the SAME nesting depth as bound1..bound4 —
 * i.e. as a sibling disjunct of the AND-list, not a parenthesized sub-group.
 * SQL's `AND` binds tighter than `OR`, so `WHERE (b1 AND b2 AND b3 AND b4) OR
 * armB` reports essentially the entire historical population of shows whose
 * newest flowsheet entry happens to be `show_end` — no `end_time IS NULL`
 * filter, no threshold, no window. The fix wraps the two arms with drizzle's
 * `or()` helper (`apps/enrichment-worker/precheck.ts`'s
 * `hasLoadBearingAlbumMetadata` is the established precedent:
 * `and(..., or(isNotNull(a), isNotNull(b)), ...)`), which renders its own
 * group in its own parens correctly nested one level inside `and()`'s, and
 * threads the literal through `eq()` as a genuine bound parameter.
 *
 * WHY THIS LIVES IN THE UNIT TIER, NOT ONLY THE INTEGRATION TWIN: the
 * integration spec (`tests/integration/legacy-mirror-reconcile-stale-open-shows.spec.js`)
 * maintains a HAND-WRITTEN SQL TWIN of this WHERE clause, forced by the
 * babel-jest integration runner having no TypeScript support. The twin writes
 * its bound correctly parenthesized by construction (`AND (... OR ...)`) —
 * it can't reproduce a drizzle `and()`/`or()` composition bug because it was
 * never built by composing drizzle query-builder calls in the first place.
 * That gave the shipped defect zero executable coverage: the twin passed
 * while production was broken. This unit test closes that gap by rendering
 * the REAL, unmodified `buildStaleOpenShowsQuery` (from `orchestrate.ts`)
 * through drizzle's own dialect, so a regression here fails fast, in the
 * unit tier, without a live Postgres.
 *
 * A PRIOR VERSION OF THIS FILE claimed "no unit test anywhere in this repo
 * can render genuine `.toSQL()` text" and settled for asserting only that
 * `or()` was called with two arguments and that its result was `and()`'s
 * last argument — a call-shape pin that would still pass with `'show_start'`
 * substituted for `'show_end'`, or `=` substituted for `IS DISTINCT FROM`:
 * it pinned the SHAPE of the composition, not the PREDICATE. That claim was
 * false. `tests/unit/utils/sql-like.test.ts` and
 * `tests/unit/services/search.service.escape.test.ts` already render real
 * SQL text in this same unit tier via `jest.unmock('drizzle-orm')` +
 * `new PgDialect().sqlToQuery(...)`. The reason THIS file's original author
 * reached for call-shape mocking instead is specific to this call site, not
 * the tier: `buildStaleOpenShowsQuery` reads `db`/`shows`/`flowsheet` from
 * `@wxyc/database`, which `jest.unit.config.ts`'s `moduleNameMapper`
 * unconditionally redirects to `tests/mocks/database.mock.ts` — a chain-
 * returning stub whose `shows`/`flowsheet` are plain `{col: 'col'}` string
 * maps, not real drizzle `Column` objects, so real `and`/`or`/`eq`/`sql`
 * cannot compose a genuine `SQL` AST from them. The fix isn't a different
 * tier; it's overriding that ONE mock for this ONE file: `jest.mock(
 * '@wxyc/database', ...)` below supplies the REAL schema (via
 * `jest.requireActual` on `shared/database/src/schema.ts` directly, which
 * `moduleNameMapper` does NOT redirect — only the bare `@wxyc/database`
 * specifier and paths ending in `shared/database/src/client` are mapped) so
 * `shows`/`flowsheet` are genuine `Column`-bearing tables, alongside a
 * minimal chain-returning `db` stub (still needed so `.select().from().where()`
 * doesn't throw, and to capture the exact `SQL` object passed to `.where()`).
 * `jest.mock(...)` with an explicit factory overrides `moduleNameMapper`'s
 * redirect for every consumer in this file's module registry, including
 * `orchestrate.ts`'s own `import ... from '@wxyc/database'` — verified
 * empirically while writing this fix (see the mutation-testing note below).
 *
 * VERIFIED BY MUTATION while writing this fix (both confirmed red against a
 * temporary edit to `orchestrate.ts`, then confirmed the file was restored
 * byte-identical before committing):
 *   1. Substituting `'show_start'` for `'show_end'` in the `eq(newestEntryType,
 *      'show_end')` arm: the rendered `params` array's fourth element became
 *      `'show_start'`, red against the `toEqual([...])` assertion below.
 *   2. Reverting the whole carve-out to the pre-fix raw
 *      `sql`(...) OR (...)`` form: `params` collapsed to three elements
 *      (`[12, 48, 12]` — no fourth bound value, since the buggy form types
 *      `'show_end'` directly into the SQL text instead of binding it) and the
 *      rendered text's parenthesization changed from `... or (...))` to
 *      `...)) OR ((...` — both red against the assertions below.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../../shared/database/src/schema');
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'from', 'where', 'orderBy']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  return { ...realSchema, db: chain };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@wxyc/database';
import {
  buildStaleOpenShowsQuery,
  type StaleOpenShowOptions,
} from '../../../../jobs/legacy-mirror-reconcile/orchestrate';

type MockChain = { where: jest.Mock };

const OPTIONS: StaleOpenShowOptions = { windowHours: 48, settleMinutes: 15, staleAfterHours: 12 };
const SCHEMA_NAME = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const dialect = new PgDialect();

describe('buildStaleOpenShowsQuery — genuinely rendered predicate (BS#2098 review item 4)', () => {
  it('binds the id-exclusion/show_end carve-out as real parameters, in the correct precedence group', () => {
    buildStaleOpenShowsQuery(OPTIONS);

    const whereArg = (db as unknown as MockChain).where.mock.calls[0][0];
    const { sql: text, params } = dialect.sqlToQuery(whereArg);

    // The predicate's four bound values, in position: staleAfterHours (the
    // threshold bound), windowHours (the outer window bound), staleAfterHours
    // again (the NOT EXISTS activity cutoff — a separate `sql` interpolation
    // of the same value, so drizzle does not dedupe it), and the literal
    // `'show_end'` genuinely bound through `eq()` — not typed into the SQL
    // text, which is exactly what the pre-fix raw-`sql` form got wrong.
    expect(params).toEqual([12, 48, 12, 'show_end']);

    // The id-exclusion/show_end disjunction is nested INSIDE the same
    // parenthesized group as the other three AND-bounds — "and (<id bound>
    // or <show_end bound>))" — not a bare `) OR (` sibling of the AND chain.
    expect(text).toContain(
      `and ("${SCHEMA_NAME}"."shows"."id" IS DISTINCT FROM (SELECT max(s2.id) FROM "${SCHEMA_NAME}"."shows" s2) or `
    );
    expect(text).not.toContain(')) OR ((');

    // end_time IS NULL / threshold / window bounds are present and AND-joined
    // ahead of the carve-out (the pre-fix bug's `OR` would otherwise apply to
    // the whole table with none of these).
    expect(text).toContain(`"${SCHEMA_NAME}"."shows"."end_time" is null and`);
    expect(text).toContain(`"${SCHEMA_NAME}"."shows"."start_time" < now() - (interval '1 hour' * $1)`);
    expect(text).toContain(`"${SCHEMA_NAME}"."shows"."start_time" > now() - (interval '1 hour' * $2)`);
    expect(text).toContain('NOT EXISTS');
  });
});
