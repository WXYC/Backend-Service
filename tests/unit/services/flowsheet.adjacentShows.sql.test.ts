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
 *   3. **Nothing mentions `end_time`.** A NULL `end_time` is not "still on the
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
const START_TIME = new Date('2026-09-07T10:00:00.000Z');

const previous = buildAdjacentShowQuery('previous', START_TIME, 42).toSQL();
const next = buildAdjacentShowQuery('next', START_TIME, 42).toSQL();

describe('buildAdjacentShowQuery — rendered statement (BS#2399)', () => {
  it.each([
    ['previous', previous.sql, '<', 'desc'],
    ['next', next.sql, '>', 'asc'],
  ])('compares %s by row value on (start_time, id)', (_direction, text, cmp) => {
    expect(text).toContain(`("${SCHEMA}"."shows"."start_time", "${SCHEMA}"."shows"."id") ${cmp} ($1::timestamptz, $2)`);
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
  ])('binds the %s pivot as (timestamp, id), never inlines it', (_direction, params) => {
    expect(params).toEqual(['2026-09-07T10:00:00.000Z', 42, 1]);
  });
});
