/**
 * WXYC/Backend-Service#2420 — non-date sorts on GET /flowsheet/search are
 * walked by offset (dj-site#1415), so each of their orderings has to be total.
 *
 * Every page is an independent query. With `ORDER BY artist_name <dir>` alone,
 * Postgres may order a tie group differently between two of those queries, so
 * a row in a group that straddles a page boundary can be served twice or not
 * at all. The fixture below is one `artist_name` tie group of seven rows read
 * at a page size of three, so both page boundaries fall inside the group.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const MARKER = 'BS2420OffsetWalkProbe';
const ROW_COUNT = 7;
const PAGE_SIZE = 3;

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

describe('GET /flowsheet/search offset walk over a non-date sort (WXYC/Backend-Service#2420)', () => {
  let sql;
  let insertedIds = [];

  beforeAll(async () => {
    sql = makeSql();
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (entry_type, artist_name, track_title, album_title, play_order, add_time)
       SELECT 'track', $1::text, $1::text || ' #' || n, 'Offset Walk Probe', n,
              TIMESTAMPTZ '2019-03-07 12:00:00+00' + (n * INTERVAL '1 minute')
       FROM generate_series(1, $2::int) AS n
       RETURNING id`,
      [MARKER, ROW_COUNT]
    );
    insertedIds = rows.map((r) => r.id);
    expect(insertedIds).toHaveLength(ROW_COUNT);
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [insertedIds]);
    }
    if (sql) {
      await sql.end();
    }
  });

  test.each([['asc'], ['desc']])(
    'sort=artist order=%s serves every row of a straddling tie group exactly once, in id order',
    async (order) => {
      const seen = [];
      for (let page = 0; page < Math.ceil(ROW_COUNT / PAGE_SIZE); page++) {
        const res = await request
          .get('/flowsheet/search')
          .query({ q: `artist:${MARKER}`, page, limit: PAGE_SIZE, sort: 'artist', order })
          .send()
          .expect(200);
        seen.push(...res.body.results.map((r) => r.id));
      }

      expect([...seen].sort((a, b) => a - b)).toEqual([...insertedIds].sort((a, b) => a - b));
      expect(new Set(seen).size).toBe(ROW_COUNT);
      // The tiebreak runs in the sort's own direction.
      const byId = [...insertedIds].sort((a, b) => (order === 'asc' ? a - b : b - a));
      expect(seen).toEqual(byId);
    }
  );
});
