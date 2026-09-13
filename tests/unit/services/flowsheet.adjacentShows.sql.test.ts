/**
 * Genuinely-rendered-SQL pin for the archive walk behind
 * `GET /flowsheet/playlist?show_id=` (BS#2399).
 *
 * Three properties of the statement are load-bearing, and none of them is
 * visible to a test driving the chain-returning `@wxyc/database` stub:
 *
 *   1. **The comparison is a row value**, `(start_time, id)`, not a strict
 *      `<`/`>` on a bare `start_time`. `shows.start_time` carries no
 *      uniqueness constraint and production holds a five-show tie group; under
 *      a bare comparison every member of a tie is skipped, so the walk steps
 *      over five shows at once.
 *   2. **The ordering matches the comparison key on both columns and in the
 *      same direction.** A mismatch does not fail loudly — it silently returns
 *      an arbitrary member of the qualifying set instead of the nearest one.
 *   3. **The pivot is sourced inside the statement**, not bound from a JS
 *      `Date`. `shows.start_time` defaults to `now()`, which Postgres stores
 *      at microsecond precision, while `Date.toISOString()` renders
 *      milliseconds. Binding the truncated value makes the pivot row satisfy
 *      its own `>` predicate on the first element of the row value, so `next`
 *      returns the show you are already looking at.
 *   4. **Nothing mentions `end_time`.** A NULL `end_time` is not "still on the
 *      air": 2,813 of production's 2,814 open shows are legacy ETL imports
 *      going back to 2006, so an open-ness filter would hide two decades of
 *      archive to hide one live show.
 *
 * The mechanism is `flowsheet.getOpenShows.sql.test.ts`'s: an explicit
 * `jest.mock` factory overrides `jest.unit.config.ts`'s unconditional redirect
 * of `@wxyc/database` to the string-map stub, supplying the REAL schema plus a
 * real (never-connected) drizzle instance. `.toSQL()` never touches the client.
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

import { buildAdjacentShowQuery } from '../../../apps/backend/services/flowsheet.service';

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const previous = buildAdjacentShowQuery('previous', 42).toSQL();
const next = buildAdjacentShowQuery('next', 42).toSQL();

describe('buildAdjacentShowQuery — rendered statement (BS#2399)', () => {
  it.each([
    ['previous', previous.sql, '<', 'desc'],
    ['next', next.sql, '>', 'asc'],
  ])('compares %s by row value on (start_time, id)', (_direction, text, cmp) => {
    expect(text).toContain(
      `("${SCHEMA}"."shows"."start_time", "${SCHEMA}"."shows"."id") ${cmp} ((select "${SCHEMA}"."shows"."start_time" from "${SCHEMA}"."shows" where "${SCHEMA}"."shows"."id" = $1), $2)`
    );
  });

  // The regression this pin exists for: a JS `Date` bound as an ISO string
  // truncates Postgres's microsecond `start_time` to milliseconds, and every
  // show `startShow` creates takes `DEFAULT now()`, so the truncation is the
  // common case rather than an edge one.
  it.each([
    ['previous', previous.sql],
    ['next', next.sql],
  ])('%s binds no JS-rendered timestamp', (_direction, text) => {
    expect(text).not.toContain('::timestamptz');
  });

  it.each([
    ['previous', previous.sql, 'desc'],
    ['next', next.sql, 'asc'],
  ])('orders %s on both comparison columns in one direction', (_direction, text, dir) => {
    expect(text).toContain(`order by "${SCHEMA}"."shows"."start_time" ${dir}, "${SCHEMA}"."shows"."id" ${dir}`);
  });

  it.each([
    ['previous', previous.sql],
    ['next', next.sql],
  ])('takes only the nearest row in the %s direction', (_direction, text) => {
    expect(text).toContain('limit $3');
  });

  it.each([
    ['previous', previous.sql],
    ['next', next.sql],
  ])('never filters the %s direction on end_time', (_direction, text) => {
    expect(text).not.toContain('end_time');
  });

  it.each([
    ['previous', previous.sql],
    ['next', next.sql],
  ])('reads only the id in the %s direction — no heap fetch past the index', (_direction, text) => {
    // `(start_time, id)` is exactly `shows_start_time_id_idx` (migration 0163),
    // so selecting nothing else keeps both lookups index-only.
    expect(text).toContain(`select "id" from "${SCHEMA}"."shows"`);
  });

  it.each([
    ['previous', previous.params],
    ['next', next.params],
  ])('binds only the %s show id, never a timestamp', (_direction, params) => {
    // Two id binds (the subquery's and the row value's) plus the limit. A
    // timestamp appearing here again would be the truncation regression: the
    // pivot instant must be read from the row, not carried in from JS.
    expect(params).toEqual([42, 42, 1]);
  });
});
