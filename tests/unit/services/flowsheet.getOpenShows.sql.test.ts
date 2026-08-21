/**
 * Genuinely-rendered-SQL pin for `GET /flowsheet/open-shows` (BS#2235).
 *
 * WHAT THIS PROTECTS. tubafrenzy's open-show list called `getNumberOfEntries`
 * once per show from inside its iteration — an N+1 that is invisible over the
 * handful of rows a dev database holds and is not invisible over production's
 * (2,814 open shows measured 2026-08-21, against a `flowsheet` table of ~2.6M
 * rows on a `db.t3.micro` with a 5s statement timeout). The replacement gets
 * its counts from ONE grouped `LEFT JOIN`, and the acceptance criterion on the
 * ticket is that a future edit cannot quietly reintroduce the per-show count.
 *
 * A call-shape mock cannot express that: "did anyone call `db.select` twice?"
 * is not the same question as "does the statement aggregate". So this renders
 * the real `buildOpenShowsQuery` through drizzle's own dialect and asserts on
 * the statement text.
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
const { sql: text, params } = buildOpenShowsQuery(new Date('2026-08-14T00:00:00.000Z')).toSQL();

describe('buildOpenShowsQuery — rendered statement (BS#2235)', () => {
  it('aggregates the entry count in the statement rather than per show', () => {
    expect(text).toContain(`count("${SCHEMA}"."flowsheet"."id")::int`);
    expect(text).toContain(`group by`);
  });

  it('reaches flowsheet through a LEFT JOIN, so a show with zero entries still appears', () => {
    // An INNER JOIN here would silently drop exactly the cohort the endpoint
    // exists for: production show 74840 is open with zero flowsheet entries.
    expect(text).toContain(
      `left join "${SCHEMA}"."flowsheet" on "${SCHEMA}"."flowsheet"."show_id" = "${SCHEMA}"."shows"."id"`
    );
  });

  it('resolves the DJ handle via a LEFT JOIN on auth_user, not a per-show lookup', () => {
    // `resolveDjNameForShow` would cost one query per show. The chain runs in
    // JS over columns this join already fetched — the same trade
    // `getShowsInTimeWindow` (BS#2062) makes.
    expect(text).toContain(`left join "auth_user" on "auth_user"."id" = "${SCHEMA}"."shows"."primary_dj_id"`);
    expect(text).toContain(`"auth_user"."dj_name"`);
  });

  it('filters on end_time IS NULL and binds the window floor as a parameter', () => {
    expect(text).toContain(`"${SCHEMA}"."shows"."end_time" is null`);
    expect(text).toContain(`"${SCHEMA}"."shows"."start_time" >= $1`);
    // Two bound values: the window floor and the row cap. Both parameters, not
    // interpolated text.
    // The floor arrives already serialized by drizzle's timestamptz encoder.
    expect(params).toEqual(['2026-08-14T00:00:00.000Z', 100]);
  });

  it('caps the row count so the read is bounded by construction', () => {
    // `window_hours` reaches 30 years, so without this the response is every
    // open show in the database in one JSON body.
    expect(text).toContain('limit $2');
  });

  it('orders oldest-first with a deterministic tie-break on id', () => {
    // Second-granularity start_time collisions are real in this data: the
    // legacy ETL produced the 00:55:35 / 00:55:41 pairs visible in
    // production's open-show tail. Without the `id` tie-break the list
    // reshuffles between identical requests.
    expect(text).toContain(`order by "${SCHEMA}"."shows"."start_time" asc, "${SCHEMA}"."shows"."id" asc`);
  });

  it('emits exactly one statement — no correlated per-show subquery', () => {
    expect(text.toLowerCase().split('select').length - 1).toBe(1);
  });

  it('groups by every non-aggregated selected column', () => {
    // Spelled out rather than leaning on Postgres inferring functional
    // dependency from `shows.id`, so a future widening of the select list
    // fails loudly here instead of at runtime.
    for (const column of [
      `"${SCHEMA}"."shows"."id"`,
      `"${SCHEMA}"."shows"."primary_dj_id"`,
      `"${SCHEMA}"."shows"."show_name"`,
      `"${SCHEMA}"."shows"."start_time"`,
      `"${SCHEMA}"."shows"."legacy_show_id"`,
      `"${SCHEMA}"."shows"."dj_name_override"`,
      `"${SCHEMA}"."shows"."legacy_dj_name"`,
      `"auth_user"."id"`,
      `"auth_user"."dj_name"`,
    ]) {
      expect(text.slice(text.indexOf('group by'))).toContain(column);
    }
  });
});
