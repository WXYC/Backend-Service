/**
 * Genuine-rendered-SQL pin for `selectShowsToCreate`'s BS#2314 guard: Sweep 1
 * must not adopt a show whose only mirrorable rows are its own `show_start` /
 * `show_end` boundary markers — the shape a `jobs/flowsheet-show-split`
 * segment has when its DJ logged no tracks before the next go-live (see that
 * job's module docblock for why its shows are written `legacy_show_id =
 * NULL` on purpose, and `orchestrate.ts`'s `SHOW_BOUNDARY_MARKER_TYPES`
 * comment for why the fix is framed as "no substantive entry" rather than
 * "came from a split").
 *
 * WHY THIS RENDERS REAL SQL RATHER THAN ASSERTING ON PORT FAKES:
 * `orchestrate.test.ts` drives `runReconcile` through fully-faked
 * `ReconcilePorts`, so `selectShowsToCreate`'s own predicate is never
 * exercised there — a fake `selectShowsToCreate` returning `[]` would pass
 * whether or not the real guard exists. The actual behavioral pin (does a
 * split-shaped show get selected against a live planner) lives in
 * `tests/integration/legacy-mirror-reconcile.spec.js`'s hand-written SQL
 * twin (updated alongside this file for BS#2314). This unit test closes the
 * gap the `stale-open-shows-sql.test.ts` docblock describes for the sibling
 * BS#2065 query: it renders the REAL, unmodified `selectShowsToCreate` WHERE
 * clause through drizzle's own dialect, so a regression to the new guard (or
 * to its placement inside the AND-chain) fails fast in the unit tier without
 * a live Postgres.
 *
 * `jest.unit.config.ts` unconditionally redirects `@wxyc/database` to a
 * chain-returning stub whose `shows`/`flowsheet` are plain string maps, not
 * real drizzle `Column` objects — real `and`/`exists`/`notExists`/`eq`/`sql`
 * can't compose a genuine `SQL` AST from them. This file overrides that ONE
 * mock (`jest.mock('@wxyc/database', ...)` with an explicit factory, which
 * takes precedence for every consumer in this file's module registry,
 * including `orchestrate.ts`'s own import) to supply the REAL schema via
 * `jest.requireActual`.
 *
 * The trickier half: `selectShowsToCreate`'s WHERE clause embeds TWO
 * correlated subqueries built via `db.select({one: sql\`1\`}).from(flowsheet)
 * .where(...)` (`entryExists(false)` — the pre-existing all-or-nothing guard
 * — and the new `hasSubstantiveEntry`). `exists()`/`notExists()` just splice
 * the subquery object into a template (`sql\`exists ${subquery}\``), and
 * drizzle recognizes it as embeddable SQL via `isSQLWrapper` — a plain
 * `typeof value.getSQL === 'function'` duck-type check. So the fake `db`
 * below returns a FRESH builder object per `.select()` call (never one
 * shared/reused chain — two subqueries built in the same WHERE clause would
 * otherwise clobber each other's captured `.from()`/`.where()` state), and
 * each builder implements `getSQL()` by genuinely rendering its own captured
 * table + condition via the real `sql` tag. That produces an honest nested
 * `SELECT 1 FROM ... WHERE ...` AST, not a stub — the same trick
 * `stale-open-shows-sql.test.ts` uses for its `Column`/`Table` objects,
 * extended one level deeper for subquery builders.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../../shared/database/src/schema');
  // `orchestrate.ts` also references `lastLoggedShowEntryOrderBySql` at
  // module scope (the BS#2065 detector's `newestEntryType`/`newestEntryAt`,
  // evaluated at import time regardless of which export this file exercises)
  // — same real helper `stale-open-shows-sql.test.ts` supplies.
  const realOrderBy = jest.requireActual('../../../../shared/database/src/last-logged-show-entry');
  const { sql } = jest.requireActual('drizzle-orm');

  const builders: Array<{ _table: unknown; _where: unknown }> = [];

  const makeBuilder = () => {
    const builder: {
      _table: unknown;
      _where: unknown;
      from: (table: unknown) => typeof builder;
      where: (cond: unknown) => typeof builder;
      orderBy: (...args: unknown[]) => typeof builder;
      getSQL: () => unknown;
    } = {
      _table: undefined,
      _where: undefined,
      from(table: unknown) {
        builder._table = table;
        return builder;
      },
      where(cond: unknown) {
        builder._where = cond;
        return builder;
      },
      orderBy() {
        return builder;
      },
      getSQL() {
        return sql`select 1 from ${builder._table} where ${builder._where}`;
      },
    };
    builders.push(builder);
    return builder;
  };

  const db = {
    select: () => makeBuilder(),
    // Exposed so the test can find the specific builder it wants (outer vs.
    // subquery) by which table it was `.from(...)`'d against, without
    // reaching for an out-of-scope closure variable (disallowed inside a
    // `jest.mock` factory).
    __builders: builders,
  };

  return { ...realSchema, ...realOrderBy, db };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db, shows, flowsheet } from '@wxyc/database';
import { selectShowsToCreate, type WindowOptions } from '../../../../jobs/legacy-mirror-reconcile/orchestrate';

type Builder = { _table: unknown; _where: unknown };
type MockDb = { __builders: Builder[] };

const OPTIONS: WindowOptions = { windowHours: 48, settleMinutes: 15 };
const SCHEMA_NAME = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const dialect = new PgDialect();

describe('selectShowsToCreate — genuinely rendered predicate (BS#2314)', () => {
  it('requires a substantive entry to exist, alongside the pre-existing all-or-nothing guard', async () => {
    await selectShowsToCreate(OPTIONS);

    const builders = (db as unknown as MockDb).__builders;
    const outer = builders.find((b) => b._table === shows);
    if (!outer) throw new Error('expected an outer builder scoped to `shows`');

    const { sql: text, params } = dialect.sqlToQuery(outer._where as Parameters<typeof dialect.sqlToQuery>[0]);

    // Both correlated subqueries are present, AND-ed alongside the window/
    // settle/DJ bounds — not a sibling OR, not dropped, not swapped for one
    // another. `notExists(...)` is the pre-existing guard (BS#1707 R4 High
    // #1); `exists(...)` is the new BS#2314 guard.
    expect(text).toContain('not exists (select 1 from');
    expect(text).toContain('exists (select 1 from');

    // The new guard's subquery is scoped to the SAME show (correlated on
    // shows.id, not a free-standing count) and excludes all four boundary-
    // marker types — dj_join/dj_leave (never mirrored at all) AND
    // show_start/show_end (mirrorable, but never evidence a set happened).
    // Order matters: `notInArray`'s spread is
    // `[...NON_MIRRORED_MARKER_TYPES, ...SHOW_BOUNDARY_MARKER_TYPES]`.
    expect(text).toContain(`"${SCHEMA_NAME}"."flowsheet"."show_id" = "${SCHEMA_NAME}"."shows"."id"`);
    expect(text).toContain(`"${SCHEMA_NAME}"."flowsheet"."entry_type" not in`);

    // Bound params, in position: settleMinutes, windowHours, then the
    // pre-existing guard's entry-type exclusion (dj_join/dj_leave only —
    // untouched, proving this guard did not silently widen too), then the
    // new guard's exclusion of all four boundary-marker types. Each
    // `notInArray` binds its values as individual params, not one array
    // param — this pins the exact widened list landed in the right place.
    expect(params).toEqual([15, 48, 'dj_join', 'dj_leave', 'dj_join', 'dj_leave', 'show_start', 'show_end']);

    // Sanity: two distinct subquery builders were built against `flowsheet`
    // (not the same one read twice), proving the fresh-builder-per-call fake
    // actually exercised both real subqueries rather than one shared mock.
    const flowsheetBuilders = builders.filter((b) => b._table === flowsheet);
    expect(flowsheetBuilders.length).toBeGreaterThanOrEqual(2);
  });
});
