/**
 * Genuinely-rendered-SQL pin for `GET /flowsheet/shows/recent` (BS#2435).
 *
 * WHAT THIS PROTECTS. The handoff read is a list of shows plus the DJs on each
 * one, which is the exact shape that invites a per-show membership lookup. The
 * invariant is two statements for the whole page — the bounded `shows` window,
 * then ONE `show_djs` read scoped to the ids that survived it — never one read
 * per show.
 *
 * The second thing pinned here is the index the window rides. `shows_open_start_time_idx`
 * (migration 0154, BS#2235) is partial on `end_time IS NULL` and cannot serve
 * this read, which is mostly closed shows; `shows_start_time_id_idx` (BS#2399)
 * is the non-partial `(start_time, id)` index that can, and the filter, range
 * bound and sort below are written to match its key exactly.
 *
 * The mechanism is the one `flowsheet.getOpenShows.sql.test.ts` established:
 * `jest.unit.config.ts`'s moduleNameMapper redirects the bare `@wxyc/database`
 * specifier to a chain-returning stub whose tables are plain string maps, so
 * real drizzle operators cannot compose an `SQL` AST from them. The explicit
 * `jest.mock` factory below overrides that redirect for this file's registry,
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
    db: drizzle({}),
  };
});

import { buildRecentShowsQuery, buildRecentShowDJsQuery } from '../../../apps/backend/services/flowsheet.service';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const page = buildRecentShowsQuery(new Date('2026-09-14T22:00:00.000Z'), 200).toSQL();
const membership = buildRecentShowDJsQuery([10, 11]).toSQL();

describe('buildRecentShowsQuery — rendered statement (BS#2435)', () => {
  it('bounds the window on start_time and truncates the page', () => {
    expect(page.sql).toContain(`from "${SCHEMA}"."shows"`);
    expect(page.sql).toContain(`"${SCHEMA}"."shows"."start_time" >= $1`);
    expect(page.sql).toContain('limit $2');
  });

  it('orders newest first, tie-broken on id', () => {
    // Newest first is what a handoff read wants, and it is also what makes the
    // row cap safe: truncation drops the OLDEST shows, which are the least
    // useful ones. `id` breaks the second-granularity `start_time` collisions
    // the legacy ETL produces.
    expect(page.sql).toContain(`order by "${SCHEMA}"."shows"."start_time" desc, "${SCHEMA}"."shows"."id" desc`);
  });

  it('does not filter on end_time — this read is mostly closed shows', () => {
    // An `end_time IS NULL` predicate here would make the endpoint a duplicate
    // of `GET /flowsheet/open-shows` and answer the wrong question: a show that
    // has ENDED is precisely the one a DJ arriving for a shift wants to see.
    expect(page.sql).not.toContain(`"${SCHEMA}"."shows"."end_time" is null`);
  });

  it('resolves the show-level handle via a LEFT JOIN on auth_user, not a per-show lookup', () => {
    // `resolveDjNameForShow` would cost one query per show. The chain runs in
    // JS over columns this join already fetched — the same trade
    // `getShowsInTimeWindow` (BS#2062) and `buildOpenShowsQuery` (BS#2235) make.
    expect(page.sql).toContain(`left join "auth_user" on "auth_user"."id" = "${SCHEMA}"."shows"."primary_dj_id"`);
    expect(page.sql).toContain('"auth_user"."dj_name"');
  });

  it('never reaches auth_user.real_name', () => {
    // The PII column this endpoint's originating request asked for and the
    // ticket ruled out of scope (docs/pii.md). Structural, not a convention:
    // the chain has no input that could carry it.
    expect(page.sql).not.toContain('real_name');
  });

  it('binds the window floor and the row cap as parameters', () => {
    expect(page.params).toEqual(['2026-09-14T22:00:00.000Z', 200]);
  });
});

describe('buildRecentShowDJsQuery — rendered statement (BS#2435)', () => {
  it('reads every page show in one statement, not one per show', () => {
    expect(membership.sql).toContain(`from "${SCHEMA}"."show_djs"`);
    expect(membership.sql).toContain(`"${SCHEMA}"."show_djs"."show_id" in ($1, $2)`);
    expect(membership.params.slice(0, 2)).toEqual([10, 11]);
  });

  it('counts only active members, matching djs-on-air', () => {
    // `getDJsInShow(show_id, true)` — the read behind `djs-on-air` — filters on
    // `active`. Without the same filter here a DJ who left mid-show would be
    // reported as having had the room for its whole length.
    expect(membership.sql).toContain(`"${SCHEMA}"."show_djs"."active" = $3`);
  });

  it('joins auth_user for the handle and orders deterministically', () => {
    expect(membership.sql).toContain(`inner join "auth_user" on "auth_user"."id" = "${SCHEMA}"."show_djs"."dj_id"`);
    // `show_djs` carries no join timestamp and no serial id, so there is no
    // "who arrived first" to read (BS#2237). A plain relational sort on the two
    // keys is the same determinism argument `activeMemberOnAirName` makes.
    expect(membership.sql).toContain(`order by "${SCHEMA}"."show_djs"."show_id" asc, "auth_user"."id" asc`);
  });

  it('never reaches auth_user.real_name', () => {
    expect(membership.sql).not.toContain('real_name');
  });
});
