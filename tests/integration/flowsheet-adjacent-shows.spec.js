/**
 * Integration test: the archive walk behind `GET /flowsheet/playlist?show_id=`
 * (BS#2399), against real Postgres.
 *
 * Two claims are the reason this exists, and neither can be checked against a
 * mocked driver — both are statements about how Postgres orders rows, not about
 * what SQL the service emits:
 *
 *   1. **The walk follows airtime, not `shows.id`.** tubafrenzy walked
 *      `MIN(ID) WHERE ID >` / `MAX(ID) WHERE ID <`, which was correct while it
 *      hand-assigned `MAX(ID)+1` at signon. Through the ETL import it stopped
 *      being: 32 of production's 72,893 shows carry a lower id than a show that
 *      aired earlier, so an id walk sends "Next Show" backwards in time at 32
 *      boundaries. The `inverted` row below is one of those.
 *   2. **A row-value comparison steps INTO a tie group where a bare `>` steps
 *      over it.** `shows.start_time` has no uniqueness constraint and
 *      production holds a five-show tie group; the third test asserts the
 *      difference between the two forms directly, on the same data.
 *
 * The integration runner is babel-jest and cannot import the service's
 * drizzle-orm TS source (same constraint as `flowsheet-etl-setwhere.spec.js`),
 * so the two queries are hand-mirrored from `buildAdjacentShowQuery`
 * (`apps/backend/services/flowsheet.service.ts`). If that shape drifts, the
 * rendered-SQL pin at `tests/unit/services/flowsheet.adjacentShows.sql.test.ts`
 * is the source of truth — fix it there and update here in lockstep.
 *
 * Rows are dated in 2099 so the walk cannot interleave with any other spec's
 * shows, and are cleaned up by their `show_name` prefix.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const NAME_PREFIX = 'bs2399:';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('archive walk over shows (BS#2399)', () => {
  let sql;
  /** show_name suffix -> { id, start_time }, in insertion (id) order. */
  const show = {};

  /** Mirrors `buildAdjacentShowQuery`. Returns the neighbour id, or null at the end. */
  async function neighbourOf(direction, pivot) {
    const rows =
      direction === 'previous'
        ? await sql`
            SELECT id FROM ${sql(SCHEMA)}.shows
            WHERE (start_time, id) < (${pivot.start_time}::timestamptz, ${pivot.id})
            ORDER BY start_time DESC, id DESC LIMIT 1`
        : await sql`
            SELECT id FROM ${sql(SCHEMA)}.shows
            WHERE (start_time, id) > (${pivot.start_time}::timestamptz, ${pivot.id})
            ORDER BY start_time ASC, id ASC LIMIT 1`;
    return rows.length === 0 ? null : rows[0].id;
  }

  beforeAll(async () => {
    sql = makeSql();
    // Insertion order IS id order. Airtime order is: oldest, inverted, tie a,
    // tie b, tie c, newest — so `inverted` holds the highest id of the six
    // while airing second.
    const seed = [
      ['oldest', '2099-01-01 00:00:00+00'],
      ['tie-a', '2099-01-02 00:00:00+00'],
      ['tie-b', '2099-01-02 00:00:00+00'],
      ['tie-c', '2099-01-02 00:00:00+00'],
      ['newest', '2099-01-03 00:00:00+00'],
      ['inverted', '2099-01-01 12:00:00+00'],
    ];
    for (const [suffix, startTime] of seed) {
      const [row] = await sql`
        INSERT INTO ${sql(SCHEMA)}.shows (show_name, start_time, end_time)
        VALUES (${NAME_PREFIX + suffix}, ${startTime}::timestamptz, NULL)
        RETURNING id, start_time`;
      show[suffix] = row;
    }
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE show_name LIKE ${NAME_PREFIX + '%'}`;
    await sql.end();
  });

  test('the fixture really does invert id order against airtime order', () => {
    // Without this the first test below would pass for the wrong reason.
    expect(show['inverted'].id).toBeGreaterThan(show['newest'].id);
    expect(show['inverted'].start_time.getTime()).toBeLessThan(show['tie-a'].start_time.getTime());
  });

  test('walks forward in airtime order, not id order', async () => {
    await expect(neighbourOf('next', show['oldest'])).resolves.toBe(show['inverted'].id);
  });

  test('steps into a tie group instead of over it', async () => {
    await expect(neighbourOf('next', show['tie-a'])).resolves.toBe(show['tie-b'].id);

    // The same pivot under the rejected form: a strict `>` on the bare column
    // skips every remaining member of the tie in one step.
    const [bare] = await sql`
      SELECT id FROM ${sql(SCHEMA)}.shows
      WHERE start_time > ${show['tie-a'].start_time}::timestamptz
        AND show_name LIKE ${NAME_PREFIX + '%'}
      ORDER BY start_time ASC LIMIT 1`;
    expect(bare.id).toBe(show['newest'].id);
  });

  test('walks backward into the last member of a tie group', async () => {
    await expect(neighbourOf('previous', show['newest'])).resolves.toBe(show['tie-c'].id);
  });

  test('is reversible — stepping forward then back returns to the same show', async () => {
    for (const suffix of ['oldest', 'inverted', 'tie-a', 'tie-b']) {
      const forwardId = await neighbourOf('next', show[suffix]);
      const [forward] = await sql`SELECT id, start_time FROM ${sql(SCHEMA)}.shows WHERE id = ${forwardId}`;
      await expect(neighbourOf('previous', forward)).resolves.toBe(show[suffix].id);
    }
  });
});
