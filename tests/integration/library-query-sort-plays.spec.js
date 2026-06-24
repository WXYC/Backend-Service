/**
 * BS#1489 — `GET /library/query?sort=plays` orders by a REAL play count.
 *
 * Regression coverage for the dead-column bug: the browse/sort path read
 * `library_artist_view.plays`, which projected the physical `library.plays`
 * column. Nothing maintains `library.plays` (it is 0 for every row), so
 * `sort=plays` silently ordered a constant and fell back to the secondary
 * `artist_name` / `id` tiebreak. The fix scopes a LEFT JOIN to the `album_plays`
 * MV into the search query (`library-search.service.ts`) and sources both the
 * sort key and the projected `plays` from `COALESCE(album_plays.plays, 0)` —
 * the same live per-album COUNT(*) the catalog export uses — so the sort and
 * the projected value carry real signal. (Scoped join, not a view
 * redefinition: the view is read by several other code paths.)
 *
 * Postgres-backed (direct SQL seeds two probe albums + flowsheet plays and
 * refreshes the MV; supertest drives the HTTP surface) — same harness as
 * library-catalog-export.spec.js.
 *
 * The two probes are arranged so the test FAILS under the old behavior:
 *   - PROBE_ZERO has the LOWER id and zero plays.
 *   - PROBE_HIGH has the HIGHER id and HIGH_PLAYS_COUNT plays.
 * Under the dead-column bug, `sort=plays desc` sees both as 0 and falls to the
 * `id ASC` tiebreak, surfacing the (wrong) zero-plays row first. With the fix,
 * the played album sorts first regardless of id.
 *
 * Probe rows live in the reserved 7000-range on ids the shape fixture leaves
 * free (7060/7062), reusing fixture artist 7000 ('XA'), genre 11 ('Rock'),
 * format 1 ('cd'), and gac (7000,11)->700 so every joined display field exists.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // fixture artist (code_letters 'XA')
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'
const PROBE_ZERO = 7060; // LOWER id, zero plays (no album_plays row -> COALESCE 0)
const PROBE_HIGH = 7062; // HIGHER id, real plays
const HIGH_PLAYS_COUNT = 4;
// Unique token shared by both album titles so `album:<token>` isolates exactly
// the two probes (contains-match, field-qualified -> deterministic primary path).
const TOKEN = 'zzsortprobe1489';

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

describe('GET /library/query?sort=plays (BS#1489)', () => {
  let auth;
  let sql;

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();

    // Zero-plays probe: lower id, no flowsheet rows.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, $5, 60, 'Shape Fixture Artist Alpha')
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_ZERO, ART, GEN, FMT, `${TOKEN} Zero Plays`]
    );

    // High-plays probe: higher id, HIGH_PLAYS_COUNT 'track' flowsheet rows.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, $5, 62, 'Shape Fixture Artist Alpha')
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_HIGH, ART, GEN, FMT, `${TOKEN} High Plays`]
    );
    for (let i = 0; i < HIGH_PLAYS_COUNT; i++) {
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
         VALUES ($1, 'track', $2, 'Shape Fixture Artist Alpha', $3, $4)`,
        [PROBE_HIGH, 9200 + i, `${TOKEN} High Plays`, `probe track ${i}`]
      );
    }

    // Roll the seeded track rows into the MV the view now reads.
    await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
  });

  afterAll(async () => {
    if (sql) {
      // flowsheet.album_id is ON DELETE SET NULL — reap the play rows by
      // album_id BEFORE deleting the library row (album_id goes NULL after).
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE album_id = $1`, [PROBE_HIGH]);
      await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id IN ($1, $2)`, [PROBE_ZERO, PROBE_HIGH]);
      // Drop the now-stale probe row from the MV so it can't leak into a later test.
      await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
      await sql.end();
    }
  });

  test('sort=plays desc surfaces the played album first (not the lower-id zero-plays row)', async () => {
    const res = await auth
      .get('/library/query')
      .query({ q: `album:${TOKEN}`, sort: 'plays', order: 'desc', limit: 10 })
      .expect(200);

    // Exactly the two probes match the unique token.
    expect(res.body.total).toBe(2);
    expect(res.body.results.map((r) => r.id)).toEqual([PROBE_HIGH, PROBE_ZERO]);

    const [first, second] = res.body.results;
    // The projected `plays` now carries real signal (was 0 for every row).
    expect(first.plays).toBe(HIGH_PLAYS_COUNT);
    // Unplayed album has no album_plays row -> LEFT JOIN -> COALESCE 0 (never null).
    expect(second.plays).toBe(0);
  });

  test('sort=plays asc surfaces the zero-plays album first', async () => {
    const res = await auth
      .get('/library/query')
      .query({ q: `album:${TOKEN}`, sort: 'plays', order: 'asc', limit: 10 })
      .expect(200);

    expect(res.body.results.map((r) => r.id)).toEqual([PROBE_ZERO, PROBE_HIGH]);
    expect(res.body.results[0].plays).toBe(0);
    expect(res.body.results[1].plays).toBe(HIGH_PLAYS_COUNT);
  });
});
