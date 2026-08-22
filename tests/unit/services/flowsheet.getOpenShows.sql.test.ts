/**
 * Genuinely-rendered-SQL pin for `GET /flowsheet/open-shows` (BS#2235).
 *
 * WHAT THIS PROTECTS, precisely. tubafrenzy's open-show list called
 * `getNumberOfEntries` once per show from inside its iteration — an N+1 of
 * ROUND TRIPS. The invariant is one statement, and the page bounded before
 * anything fans out from it.
 *
 * A prior version of this file asserted "the rendered text contains exactly
 * one `select` keyword", which conflates a subquery with a round trip. That
 * pin was not just imprecise, it was actively harmful: it forbade the very
 * shape that fixes the performance defect. The first cut of the query was a
 * `LEFT JOIN flowsheet … GROUP BY … LIMIT`, and `LIMIT` after `GROUP BY`
 * cannot push down — at the widened window `getOpenShows` documents for
 * reaching the 2006 tail that means grouping all 2,814 open shows across
 * ~100k joined `flowsheet` rows (each needing a heap fetch, since no index on
 * `show_id` carries `flowsheet.id`) and then discarding 2,714 of them. The
 * assertions below pin the property that actually matters instead.
 *
 * The mechanism is the one `tests/unit/jobs/legacy-mirror-reconcile/stale-open-shows-sql.test.ts`
 * established: `jest.unit.config.ts`'s moduleNameMapper unconditionally
 * redirects the bare `@wxyc/database` specifier to a chain-returning stub whose
 * tables are plain string maps, so real drizzle operators cannot compose an
 * `SQL` AST from them. An explicit `jest.mock` factory overrides that redirect
 * for this file's registry — including `flowsheet.service.ts`'s own import —
 * supplying the REAL schema plus a real (never-connected) drizzle instance.
 * `.toSQL()` never touches the client.
 */

jest.unmock('drizzle-orm');

jest.mock('@wxyc/database', () => {
  const realSchema = jest.requireActual('../../../shared/database/src/schema');
  const realDjName = jest.requireActual('../../../shared/database/src/dj-name');
  const realOrderBy = jest.requireActual('../../../shared/database/src/last-logged-show-entry');
  const { drizzle } = jest.requireActual('drizzle-orm/postgres-js');
  return {
    ...realSchema,
    ...realDjName,
    ...realOrderBy,
    // A drizzle instance over a client that is never called: the query builder
    // renders SQL without executing, and nothing in this file awaits a query.
    db: drizzle({}),
  };
});

import { buildOpenShowsQuery } from '../../../apps/backend/services/flowsheet.service';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const { sql: text, params } = buildOpenShowsQuery(new Date('2026-08-14T00:00:00.000Z'), 100).toSQL();

/** Everything up to the first join — i.e. the subquery that produces the page. */
const beforeJoin = text.slice(0, text.indexOf('left join'));

describe('buildOpenShowsQuery — rendered statement (BS#2235)', () => {
  it('truncates the page BEFORE anything joins to it', () => {
    // The load-bearing assertion. `limit` must land inside the `shows`
    // subquery, not at the end of a grouped join — that is the difference
    // between bounded work and 2,814 groups at the widened window.
    expect(beforeJoin).toContain('limit $2');
    expect(beforeJoin).toContain(`from "${SCHEMA}"."shows"`);
  });

  it('bounds the page on the partial index: end_time IS NULL, ordered by start_time', () => {
    // Filter, range bound and sort all come from `shows_open_start_time_idx`
    // (migration 0154), so the truncation above is an index-only scan.
    expect(beforeJoin).toContain(`"${SCHEMA}"."shows"."end_time" is null`);
    expect(beforeJoin).toContain(`"${SCHEMA}"."shows"."start_time" >= $1`);
    expect(beforeJoin).toContain(`order by "${SCHEMA}"."shows"."start_time" asc, "${SCHEMA}"."shows"."id" asc`);
  });

  it('counts entries in the same statement — one round trip, not the legacy N+1', () => {
    expect(text).toContain(
      `(SELECT count(*) FROM "${SCHEMA}"."flowsheet" WHERE "${SCHEMA}"."flowsheet"."show_id" = "page"."id")`
    );
  });

  it('counts with count(*), so the subquery is index-only', () => {
    // `count(flowsheet.id)` — the grouped form's aggregate — would force a heap
    // fetch per row, because neither `flowsheet_show_id_idx` nor
    // `flowsheet_show_id_play_order_idx` carries `id`. `count(*)` needs no
    // column value and is served entirely from the index.
    expect(text).toContain('count(*)');
    expect(text).not.toContain(`count("${SCHEMA}"."flowsheet"."id")`);
  });

  it('reaches flowsheet only through the correlated count, never an outer join', () => {
    // An outer join to `flowsheet` would re-introduce the fan-out this shape
    // exists to avoid, and an INNER one would silently drop exactly the cohort
    // the endpoint is for — production show 74840 is open with zero entries.
    expect(text).not.toContain(`join "${SCHEMA}"."flowsheet"`);
  });

  it('resolves the DJ handle via a LEFT JOIN on auth_user, not a per-show lookup', () => {
    // `resolveDjNameForShow` would cost one query per show. The chain runs in
    // JS over columns this join already fetched — the same trade
    // `getShowsInTimeWindow` (BS#2062) makes. Joined to the already-truncated
    // page, so it too is bounded by `limit`.
    expect(text).toContain(`left join "auth_user" on "auth_user"."id" = "page"."primary_dj_id"`);
    expect(text).toContain(`"auth_user"."dj_name"`);
  });

  it('re-states the ordering on the outer statement', () => {
    // A subquery is unordered by definition; without this the planner is free
    // to reshuffle the page after the join. Second-granularity `start_time`
    // collisions are real in this data (the legacy ETL's 00:55:35 / 00:55:41
    // pairs), which is what the `id` tie-break is for.
    expect(text.slice(text.indexOf('left join'))).toContain('order by "page"."start_time" asc, "page"."id" asc');
  });

  it('binds the window floor and the row cap as parameters', () => {
    // The floor arrives already serialized by drizzle's timestamptz encoder.
    expect(params).toEqual(['2026-08-14T00:00:00.000Z', 100]);
  });
});
