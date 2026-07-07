/**
 * BS#1500 — `GET /library/bmi-performance-list` (tubafrenzy `recentBMI` successor).
 *
 * The station librarian pulls played musical works for a date range to submit to
 * BMI. This pins the load-bearing server contract the dj-site admin tool reads:
 * the `flowsheet` filter (track rows with an artist, `add_time` in the requested
 * window), the composer-provenance coverage summary, and the `from`/`to`
 * validation. The BMI submission *format* + artist-proxy inclusion default are
 * finalized in #1507; this spec deliberately does not assert them.
 *
 * Postgres-backed (BS `pg` analogue): direct SQL seeds a deterministic set of
 * rows in an isolated historical window (2013-07-04) that no other spec writes
 * to, so the global coverage counts are exact. The permission gate
 * (`catalog:['write']`, MD/SM) is not asserted here — the CI env runs with
 * AUTH_BYPASS, so `requirePermissions` is a no-op; the gate is the same proven
 * middleware guarding POST /library.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ARTIST = 'BS#1500 BMI Probe Artist';
const WINDOW_DAY = '2013-07-04'; // isolated: no other spec seeds 2013 timestamps
const IN_WINDOW = '2013-07-04T12:00:00.000Z';
const BEFORE_WINDOW = '2013-07-03T12:00:00.000Z';
const AT_EXCLUSIVE_END = '2013-07-05T00:00:00.000Z'; // == toExclusive -> excluded (half-open)

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

describe('GET /library/bmi-performance-list (BS#1500)', () => {
  let auth;
  let sql;

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();

    // Idempotent across re-runs of this spec (shared schema, --runInBand).
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = $1 OR message = $2`, [
      ARTIST,
      'BS#1500 breakpoint probe',
    ]);

    // Four in-window TRACK rows, one per composer provenance -> all returned.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet
         (entry_type, play_order, artist_name, track_title, album_title, record_label, composer, composer_source, add_time)
       VALUES
         ('track', 8500, $1, 'real-track cut',   'Album A', 'Label A', 'Composer A', 'discogs_track',   $2),
         ('track', 8501, $1, 'real-release cut', 'Album B', 'Label B', 'Composer B', 'discogs_release', $2),
         ('track', 8502, $1, 'proxy cut',        'Album C', 'Label C', $1,           'artist_proxy',    $2),
         ('track', 8503, $1, 'unenriched cut',   'Album D', 'Label D', NULL,          NULL,             $2)`,
      [ARTIST, IN_WINDOW]
    );

    // Excluded: a non-track (breakpoint) row in the window.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (entry_type, play_order, message, add_time)
       VALUES ('breakpoint', 8504, 'BS#1500 breakpoint probe', $1)`,
      [IN_WINDOW]
    );
    // Excluded: a track with NULL artist in the window.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (entry_type, play_order, artist_name, track_title, add_time)
       VALUES ('track', 8505, NULL, 'null-artist cut', $1)`,
      [IN_WINDOW]
    );
    // Excluded: an in-artist track just BEFORE the window and one AT the
    // exclusive upper bound (proves the half-open [from, to] interval).
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet
         (entry_type, play_order, artist_name, track_title, composer_source, add_time)
       VALUES
         ('track', 8506, $1, 'before-window cut', 'discogs_track', $2),
         ('track', 8507, $1, 'after-window cut',  'discogs_track', $3)`,
      [ARTIST, BEFORE_WINDOW, AT_EXCLUSIVE_END]
    );
  });

  afterAll(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE artist_name = $1 OR message = $2`, [
      ARTIST,
      'BS#1500 breakpoint probe',
    ]);
    await sql.end();
  });

  it('returns the in-window track rows with an exact composer-provenance coverage summary', async () => {
    const res = await auth.get(`/library/bmi-performance-list?from=${WINDOW_DAY}&to=${WINDOW_DAY}`);

    expect(res.status).toBe(200);
    expect(res.body.range).toEqual({ from: WINDOW_DAY, to: WINDOW_DAY });
    // Window is isolated to this spec, so the global counts are exactly the four seeded tracks.
    expect(res.body.coverage).toEqual({ total: 4, real_track: 1, real_release: 1, artist_proxy: 1, none: 1 });
    expect(res.body.rows).toHaveLength(4);
    expect(res.body.coverage.total).toBe(res.body.rows.length);
  });

  it('excludes non-track rows, null-artist rows, and rows outside the half-open window', async () => {
    const res = await auth.get(`/library/bmi-performance-list?from=${WINDOW_DAY}&to=${WINDOW_DAY}`);

    const titles = res.body.rows.map((r) => r.track_title);
    expect(titles).toEqual(
      expect.arrayContaining(['real-track cut', 'real-release cut', 'proxy cut', 'unenriched cut'])
    );
    expect(titles).not.toContain('null-artist cut'); // artist_name IS NULL
    expect(titles).not.toContain('before-window cut'); // add_time < from
    expect(titles).not.toContain('after-window cut'); // add_time == toExclusive (excluded)
    // Every row is a real artist play inside the window.
    for (const row of res.body.rows) {
      expect(row.artist_name).toBe(ARTIST);
      expect(new Date(row.played_at).getTime()).toBeGreaterThanOrEqual(new Date(`${WINDOW_DAY}T00:00:00Z`).getTime());
      expect(new Date(row.played_at).getTime()).toBeLessThan(new Date(AT_EXCLUSIVE_END).getTime());
    }
  });

  it('projects exactly the BMI contract fields and no server-only columns', async () => {
    const res = await auth.get(`/library/bmi-performance-list?from=${WINDOW_DAY}&to=${WINDOW_DAY}`);

    const row = res.body.rows.find((r) => r.track_title === 'real-track cut');
    expect(Object.keys(row).sort()).toEqual(
      ['album_title', 'artist_name', 'composer', 'composer_source', 'played_at', 'record_label', 'track_title'].sort()
    );
    expect(row.composer_source).toBe('discogs_track');
    expect(row).not.toHaveProperty('dj_name');
    expect(row).not.toHaveProperty('search_doc');
    expect(row).not.toHaveProperty('id');
  });

  it.each([
    ['from missing', `/library/bmi-performance-list?to=${WINDOW_DAY}`],
    ['to missing', `/library/bmi-performance-list?from=${WINDOW_DAY}`],
    ['from malformed', `/library/bmi-performance-list?from=07-04-2013&to=${WINDOW_DAY}`],
    ['impossible date', `/library/bmi-performance-list?from=2013-02-30&to=${WINDOW_DAY}`],
    ['from after to', `/library/bmi-performance-list?from=2013-07-05&to=2013-07-04`],
  ])('rejects a bad range with 400 (%s)', async (_label, path) => {
    const res = await auth.get(path);
    expect(res.status).toBe(400);
  });
});
