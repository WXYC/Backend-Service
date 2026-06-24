/**
 * BS#1468 (Epic F pattern, parent #1466) — `GET /library/catalog` bulk export.
 *
 * Full-catalog gzipped NDJSON, gated by `conditionalGet(getCatalogLastModifiedAt)`
 * so a client that has cloned the catalog re-pulls only when the
 * `library_watermark` advances. Postgres-backed (the BS analogue of the org `pg`
 * marker): direct SQL drives the watermark and seeds deterministic rotation
 * shapes, supertest drives the HTTP surface.
 *
 * Probe rows live in the reserved 7000-range (shape fixture's namespace) on ids
 * the fixture leaves free (7050/7052). They reuse fixture artist 7000 (code
 * letters 'XA'), genre 11 ('Rock'), format 1 ('cd'), and gac (7000,11)->700, so
 * every joined display field is a known constant.
 */

const zlib = require('zlib');
const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // fixture artist (code_letters 'XA')
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'
const PROBE_ACTIVE = 7050;
const PROBE_EXPIRED = 7052;
const PROBE_PLAYS = 7054; // album with seeded flowsheet track plays (BS#1486)
const PROBE_PLAYS_COUNT = 5; // number of 'track' flowsheet rows seeded for PROBE_PLAYS

// Exactly the export contract field set (#1468 AC), sorted for comparison.
const CONTRACT_KEYS = [
  'album_title',
  'artist_name',
  'artwork_url',
  'code_artist_number',
  'code_letters',
  'code_number',
  'format_name',
  'genre_name',
  'id',
  'label',
  'on_streaming',
  'plays',
  'rotation_bin',
  'rotation_kill_date',
].sort();

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

// Collect the raw response bytes (superagent's gzip auto-inflate may or may not
// run for application/x-ndjson + a custom parser, so we detect the gzip magic
// and inflate ourselves — robust to both paths).
function collectBuffer(res, cb) {
  const chunks = [];
  res.on('data', (d) => chunks.push(Buffer.from(d)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
function decodeBody(res) {
  let buf = Buffer.isBuffer(res.body) && res.body.length ? res.body : Buffer.from(res.text || '', 'utf8');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}
function parseRows(res) {
  return decodeBody(res)
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}
const getCatalog = (auth) => auth.get('/library/catalog').buffer(true).parse(collectBuffer);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('GET /library/catalog (BS#1468)', () => {
  let auth;
  let sql;

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();

    // Probe album with an active 'H' record added recently AND a killed 'L'
    // record added earlier but carrying a HIGHER serial id. The export must pick
    // the most-recently-ADDED record ('H', not the higher-id 'L'); ordering by
    // id would wrongly surface the stale killed row.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, label, on_streaming, plays, artwork_url)
       VALUES ($1, $2, $3, $4, 'BS#1468 Export Probe Active', 91, 'Shape Fixture Artist Alpha', 'Probe Label A', true, 7, 'https://probe.test/a.jpg')
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_ACTIVE, ART, GEN, FMT]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (id, album_id, rotation_bin, add_date, kill_date)
       VALUES (7050, $1, 'H', '2025-01-01', NULL),
              (7051, $1, 'L', '2023-01-01', '2023-12-31')
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_ACTIVE]
    );

    // Probe album whose only rotation record is EXPIRED (kill_date in the past).
    // The view's CURRENT_DATE filter would drop it (rotation_bin -> NULL); the
    // export must ship it RAW so the client evaluates expiry against its clock.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, 'BS#1468 Export Probe Expired', 92, 'Shape Fixture Artist Alpha')
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_EXPIRED, ART, GEN, FMT]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (id, album_id, rotation_bin, add_date, kill_date)
       VALUES (7052, $1, 'M', '2024-06-01', '2024-07-01')
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_EXPIRED]
    );

    // Probe album with real flowsheet play history (BS#1486). `plays` is sourced
    // from the `album_plays` MV (count of 'track' flowsheet rows with this
    // album_id), NOT the dead `library.plays` column. Seed PROBE_PLAYS_COUNT
    // 'track' rows plus one non-track ('breakpoint') row carrying the same
    // album_id — the non-track row must be excluded by the MV's
    // `entry_type='track'` filter, so the exported count stays exactly
    // PROBE_PLAYS_COUNT, not +1.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library
         (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, 'BS#1486 Export Probe Plays', 93, 'Shape Fixture Artist Alpha')
       ON CONFLICT (id) DO NOTHING`,
      [PROBE_PLAYS, ART, GEN, FMT]
    );
    for (let i = 0; i < PROBE_PLAYS_COUNT; i++) {
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, artist_name, album_title, track_title)
         VALUES ($1, 'track', $2, 'Shape Fixture Artist Alpha', 'BS#1486 Export Probe Plays', $3)`,
        [PROBE_PLAYS, 9000 + i, `probe track ${i}`]
      );
    }
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, play_order, message)
       VALUES ($1, 'breakpoint', 9100, 'non-track row that must NOT count toward plays')`,
      [PROBE_PLAYS]
    );
  });

  afterAll(async () => {
    if (sql) {
      // flowsheet.album_id is ON DELETE SET NULL, so reap the seeded play rows by
      // album_id BEFORE deleting the library row (after which album_id is NULL and
      // unfindable). rotation.album_id is ON DELETE CASCADE, so the library delete
      // reaps the probe rotation rows.
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE album_id = $1`, [PROBE_PLAYS]);
      await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id IN ($1, $2, $3)`, [
        PROBE_ACTIVE,
        PROBE_EXPIRED,
        PROBE_PLAYS,
      ]);
      // Drop the now-stale PROBE_PLAYS row from the MV so it can't leak into a
      // later test's export.
      await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
      await sql.end();
    }
  });

  test('returns the full catalog as gzipped NDJSON with freshness + content headers', async () => {
    const res = await auth.get('/library/catalog').set('Accept-Encoding', 'gzip').buffer(true).parse(collectBuffer);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect((res.headers['vary'] || '').toLowerCase()).toContain('accept-encoding');
    expect(res.headers['last-modified']).toBeTruthy();
    expect((res.headers['content-type'] || '').toLowerCase()).toContain('ndjson');

    const rows = parseRows(res);
    expect(rows.length).toBeGreaterThan(0);
    // Every line carries exactly the contract field set — no search_doc, no
    // alphabetical_name, no view-internal extras.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(CONTRACT_KEYS);
    }
    expect(decodeBody(res)).not.toContain('search_doc');
  });

  test('honors Accept-Encoding: gzip;q=0 by serving identity (not gzip the client refused)', async () => {
    // q=0 is an explicit refusal of gzip (RFC 9110). The handler must serve an
    // uncompressed body — a substring `includes('gzip')` check would wrongly
    // send gzip bytes the client won't inflate.
    const res = await auth.get('/library/catalog').set('Accept-Encoding', 'gzip;q=0').buffer(true).parse(collectBuffer);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    // Body is plaintext NDJSON the client can parse without inflating.
    const rows = parseRows(res);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(CONTRACT_KEYS);
  });

  test('exports raw rotation_bin + rotation_kill_date (most-recently-added record, NOT the view CURRENT_DATE filter)', async () => {
    const byId = new Map(parseRows(await getCatalog(auth)).map((r) => [r.id, r]));

    const active = byId.get(PROBE_ACTIVE);
    expect(active).toBeDefined();
    // 'H' (added 2025-01-01) wins over the higher-id killed 'L' (added 2023) —
    // ordering is by add_date, not serial id.
    expect(active.rotation_bin).toBe('H');
    expect(active.rotation_kill_date).toBeNull();
    // Joined display fields resolve to their fixture constants.
    expect(active.artist_name).toBe('Shape Fixture Artist Alpha');
    expect(active.code_letters).toBe('XA');
    expect(active.code_artist_number).toBe(700);
    expect(active.genre_name).toBe('Rock');
    expect(active.format_name).toBe('cd');
    expect(active.on_streaming).toBe(true);

    const expired = byId.get(PROBE_EXPIRED);
    expect(expired).toBeDefined();
    // Raw export: the view would have filtered this expired row to rotation_bin
    // NULL; the export ships the real bin + the past kill_date.
    expect(expired.rotation_bin).toBe('M');
    expect(expired.rotation_kill_date).toBe('2024-07-01');
  });

  test('artist_name is never null: a row with NULL library.artist_name falls back to the authoritative artists.artist_name', async () => {
    // library.artist_name is nullable ("Nullable until A.2"); shape fixture row
    // 7006 has it NULL. The OpenAPI/TS contract types artist_name as a non-null
    // string (generated iOS/Kotlin decoders would throw on null), so the export
    // must COALESCE to artists.artist_name (NOT NULL) rather than ship null.
    const byId = new Map(parseRows(await getCatalog(auth)).map((r) => [r.id, r]));
    const nullArtistRow = byId.get(7006);
    expect(nullArtistRow).toBeDefined();
    expect(nullArtistRow.artist_name).toBe('Shape Fixture Artist Alpha');
  });

  test('plays is the real per-release play count from album_plays, not the dead library.plays column (BS#1486)', async () => {
    // Refresh the MV so the seeded flowsheet 'track' rows roll up into album_plays,
    // then advance the watermark (the per-watermark export cache is keyed on
    // library_watermark, which album_plays refresh does NOT bump) so the next GET
    // rebuilds the export against the refreshed MV.
    await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
    await sql.unsafe(`UPDATE "${SCHEMA}".library SET album_title = album_title WHERE id = $1`, [PROBE_PLAYS]);

    const byId = new Map(parseRows(await getCatalog(auth)).map((r) => [r.id, r]));

    // A played album exports its real count — and exactly the count of 'track'
    // rows, excluding the non-track ('breakpoint') row seeded with the same
    // album_id.
    const played = byId.get(PROBE_PLAYS);
    expect(played).toBeDefined();
    expect(played.plays).toBe(PROBE_PLAYS_COUNT);

    // An album with no flowsheet track rows has no album_plays row; the LEFT JOIN
    // COALESCEs to 0 — never JSON null — so consumers can rank numerically.
    const unplayed = byId.get(PROBE_EXPIRED);
    expect(unplayed).toBeDefined();
    expect(unplayed.plays).toBe(0);
  });

  test('returns 304 when If-Modified-Since matches the current watermark', async () => {
    const first = await getCatalog(auth);
    expect(first.status).toBe(200);

    const second = await auth.get('/library/catalog').set('If-Modified-Since', first.headers['last-modified']);
    expect(second.status).toBe(304);
    expect(second.text === '' || second.text === undefined).toBe(true);
  });

  test('returns 200 after a library row changes (watermark advanced)', async () => {
    const first = await getCatalog(auth);
    const lastModified = first.headers['last-modified'];

    // Ensure the next watermark lands in a strictly later whole second than the
    // captured Last-Modified (HTTP Date precision is whole seconds).
    await sleep(1100);
    await sql.unsafe(`UPDATE "${SCHEMA}".library SET plays = COALESCE(plays, 0) WHERE id = $1`, [PROBE_ACTIVE]);

    const after = await auth
      .get('/library/catalog')
      .set('If-Modified-Since', lastModified)
      .buffer(true)
      .parse(collectBuffer);
    expect(after.status).toBe(200);
  });

  test('returns 200 after a genres parent-table change (coverage invariant: trigger fan-out reaches the endpoint)', async () => {
    const first = await getCatalog(auth);
    const lastModified = first.headers['last-modified'];

    await sleep(1100);
    // A write on a join parent (genres) — no library row touched. The 0105
    // fan-out trigger must advance the watermark so the client re-pulls.
    await sql.unsafe(`UPDATE "${SCHEMA}".genres SET genre_name = genre_name WHERE id = $1`, [GEN]);

    const after = await auth
      .get('/library/catalog')
      .set('If-Modified-Since', lastModified)
      .buffer(true)
      .parse(collectBuffer);
    expect(after.status).toBe(200);
  });

  test('requires catalog:read auth (401 without a token)', async () => {
    const res = await request.get('/library/catalog');
    expect(res.status).toBe(401);
  });
});
