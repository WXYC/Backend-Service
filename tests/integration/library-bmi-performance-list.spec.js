/**
 * BS#1500 — `GET /library/bmi-performance-list` (tubafrenzy `recentBMI` successor).
 *
 * The station librarian pulls played musical works for a date range to submit to
 * BMI. This pins the load-bearing server contract the dj-site admin tool reads:
 * the `flowsheet` filter (track rows with a usable artist, `add_time` in the
 * requested half-open window), chronological ordering, the composer-provenance
 * coverage summary, and the `from`/`to` validation (including the max-width cap).
 * The BMI submission *format* + artist-proxy inclusion default are finalized in
 * #1507; this spec deliberately does not assert them.
 *
 * Postgres-backed (BS `pg` analogue): direct SQL seeds a deterministic set of
 * rows in an isolated historical window (2013-07-04) that no other spec writes
 * to, so the global coverage counts are exact. Cleanup is a `add_time`-window
 * DELETE (not artist/message-predicated) so every seeded row — including the
 * NULL/blank-artist rows that no equality predicate matches — is removed and
 * cannot leak across runs. The permission gate (`catalog:['write']`, MD/SM) is
 * not asserted here — the CI env runs with AUTH_BYPASS, so `requirePermissions`
 * is a no-op; the gate is the same proven middleware guarding POST /library.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ARTIST = 'BS#1500 BMI Probe Artist';
const WINDOW_DAY = '2013-07-04'; // isolated: no other spec seeds 2013 timestamps
const EMPTY_DAY = '2013-07-06'; // isolated day with zero seeded rows -> empty-window path
const AT_LOWER_BOUND = '2013-07-04T00:00:00.000Z'; // == fromDate -> included (half-open lower bound)
const AT_EXCLUSIVE_END = '2013-07-05T00:00:00.000Z'; // == toExclusive -> excluded (half-open upper bound)
// Cleanup window brackets every seeded add_time (2013-07-03 .. 2013-07-05) with margin.
const CLEANUP_FROM = '2013-07-01T00:00:00.000Z';
const CLEANUP_TO = '2013-07-08T00:00:00.000Z';

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

    // Idempotent across re-runs (shared schema, --runInBand). Window DELETE covers
    // every seeded row regardless of artist_name/message, so nothing leaks.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE add_time >= $1 AND add_time < $2`, [
      CLEANUP_FROM,
      CLEANUP_TO,
    ]);

    // Four in-window TRACK rows, one per composer provenance, at DISTINCT timestamps
    // (00:00/06:00/12:00/18:00) so ORDER BY add_time ASC is assertable. The 00:00 row
    // sits exactly at the lower bound (== fromDate) to pin the inclusive `gte` boundary.
    // Deliberately INSERTED in reverse-chronological order: neither insertion order nor
    // the DESC add_time index yields the asserted ascending order, so a DROPPED (not just
    // flipped) `orderBy` fails the ordering assertion too.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet
         (entry_type, play_order, artist_name, track_title, album_title, record_label, composer, composer_source, add_time)
       VALUES
         ('track', 8500, $1, 'unenriched cut',   'Album D', 'Label D', NULL,          NULL,             '2013-07-04T18:00:00.000Z'),
         ('track', 8501, $1, 'proxy cut',        'Album C', 'Label C', $1,           'artist_proxy',    '2013-07-04T12:00:00.000Z'),
         ('track', 8502, $1, 'real-release cut', 'Album B', 'Label B', 'Composer B', 'discogs_release', '2013-07-04T06:00:00.000Z'),
         ('track', 8503, $1, 'real-track cut',   'Album A', 'Label A', 'Composer A', 'discogs_track',   '2013-07-04T00:00:00.000Z')`,
      [ARTIST]
    );

    // Excluded: a non-track (breakpoint) row in the window.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (entry_type, play_order, message, add_time)
       VALUES ('breakpoint', 8504, 'BS#1500 breakpoint probe', '2013-07-04T12:00:00.000Z')`
    );
    // Excluded: track rows with no usable artist — NULL, empty, and whitespace-only.
    // The live free-text insert path only rejects an ABSENT artist_name, so '', spaces,
    // and tabs/newlines are all writable; the read drops them via `~ '[^[:space:]]'`.
    // The tab+newline+space row would survive a `trim()`-and-compare (trim strips only
    // ASCII spaces), so it pins the regex predicate specifically.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (entry_type, play_order, artist_name, track_title, add_time)
       VALUES
         ('track', 8505, NULL,       'null-artist cut',       '2013-07-04T12:00:00.000Z'),
         ('track', 8506, '',         'blank-artist cut',      '2013-07-04T12:00:00.000Z'),
         ('track', 8507, E'\t\n ',   'whitespace-artist cut', '2013-07-04T12:00:00.000Z')`
    );
    // Excluded: an in-artist track just BEFORE the window and one AT the exclusive
    // upper bound (proves the half-open [from, toExclusive) interval).
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet
         (entry_type, play_order, artist_name, track_title, composer_source, add_time)
       VALUES
         ('track', 8508, $1, 'before-window cut', 'discogs_track', '2013-07-03T12:00:00.000Z'),
         ('track', 8509, $1, 'after-window cut',  'discogs_track', $2)`,
      [ARTIST, AT_EXCLUSIVE_END]
    );
  });

  afterAll(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE add_time >= $1 AND add_time < $2`, [
      CLEANUP_FROM,
      CLEANUP_TO,
    ]);
    await sql.end();
  });

  it('returns the in-window track rows with an exact composer-provenance coverage summary', async () => {
    const res = await auth.get(`/library/bmi-performance-list?from=${WINDOW_DAY}&to=${WINDOW_DAY}`);

    expect(res.status).toBe(200);
    expect(res.body.range).toEqual({ from: WINDOW_DAY, to: WINDOW_DAY });
    // Window is isolated to this spec, so the global counts are exactly the four seeded tracks.
    expect(res.body.coverage).toEqual({
      total: 4,
      real_track: 1,
      real_release: 1,
      artist_proxy: 1,
      none: 1,
      unknown: 0,
    });
    expect(res.body.rows).toHaveLength(4);
    expect(res.body.coverage.total).toBe(res.body.rows.length);
  });

  it('orders rows chronologically, includes the lower bound, and excludes non-track / no-artist / out-of-window rows', async () => {
    const res = await auth.get(`/library/bmi-performance-list?from=${WINDOW_DAY}&to=${WINDOW_DAY}`);

    const titles = res.body.rows.map((r) => r.track_title);
    // Exact ordered comparison pins ORDER BY add_time ASC (00:00 -> 06:00 -> 12:00 -> 18:00)
    // AND the inclusive lower bound: 'real-track cut' is logged at exactly `from` midnight,
    // so a `gt`-instead-of-`gte` regression would drop it and fail this assertion.
    expect(titles).toEqual(['real-track cut', 'real-release cut', 'proxy cut', 'unenriched cut']);
    expect(titles).not.toContain('null-artist cut'); // artist_name IS NULL
    expect(titles).not.toContain('blank-artist cut'); // artist_name = ''
    expect(titles).not.toContain('whitespace-artist cut'); // artist_name = '   ' (trimmed to '')
    expect(titles).not.toContain('before-window cut'); // add_time < from
    expect(titles).not.toContain('after-window cut'); // add_time == toExclusive (excluded)
    // Every row is a real artist play inside the half-open window.
    for (const row of res.body.rows) {
      expect(row.artist_name).toBe(ARTIST);
      expect(new Date(row.played_at).getTime()).toBeGreaterThanOrEqual(new Date(AT_LOWER_BOUND).getTime());
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

  it('returns 200 with an empty row list and all-zero coverage for a window with no plays', async () => {
    const res = await auth.get(`/library/bmi-performance-list?from=${EMPTY_DAY}&to=${EMPTY_DAY}`);

    expect(res.status).toBe(200);
    expect(res.body.range).toEqual({ from: EMPTY_DAY, to: EMPTY_DAY });
    expect(res.body.rows).toEqual([]);
    expect(res.body.coverage).toEqual({
      total: 0,
      real_track: 0,
      real_release: 0,
      artist_proxy: 0,
      none: 0,
      unknown: 0,
    });
  });

  it.each([
    ['from missing', `/library/bmi-performance-list?to=${WINDOW_DAY}`],
    ['to missing', `/library/bmi-performance-list?from=${WINDOW_DAY}`],
    ['from malformed', `/library/bmi-performance-list?from=07-04-2013&to=${WINDOW_DAY}`],
    ['impossible date', `/library/bmi-performance-list?from=2013-02-30&to=${WINDOW_DAY}`],
    ['from after to', `/library/bmi-performance-list?from=2013-07-05&to=2013-07-04`],
    ['range too wide', `/library/bmi-performance-list?from=2013-01-01&to=2014-12-31`],
  ])('rejects a bad range with 400 (%s)', async (_label, path) => {
    const res = await auth.get(path);
    expect(res.status).toBe(400);
  });
});
