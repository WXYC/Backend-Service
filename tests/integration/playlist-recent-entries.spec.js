/**
 * End-to-end integration test for GET /playlists/recentEntries against a
 * REAL Postgres and the REAL running Express app (supertest over HTTP —
 * the integration runner is babel-jest with no TS support, so this cannot
 * import apps/backend/services/playlist-proxy.service.ts directly; see
 * playlist-proxy-artwork-tiebreak.spec.js for the same constraint).
 *
 * Phase 3 of the tubafrenzy decommission (WXYC/wiki#88) reimplemented
 * getRecentEntries to query Backend-Service's own `flowsheet` table
 * directly instead of an SSE-fed in-memory buffer. This spec is the
 * end-to-end proof the new query actually works against real Postgres:
 * entry_type -> tubafrenzy wire-vocabulary grouping (track/talkset/
 * dj_join/breakpoint/show_start), the rotation_bin fallback subquery,
 * request/rotation string coercion, breakpoint radio_hour vs. floored
 * add_time, and the BS#1105 artwork tie-break in context (two flowsheet
 * plays of the same artist+album, linked to different album_ids, both
 * resolving to the lower album_id's artwork).
 *
 * Fresh rows only (no fixed-id assumptions — local dev DB volumes persist
 * and drift; see flowsheet-upcoming-show-support.spec.js for the same
 * rationale). flowsheet.id is a serial PK, so freshly-inserted probe rows
 * always sort first under `ORDER BY id DESC`, independent of whatever else
 * is in the table.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ART = 7000; // fixture artist (code_letters 'XA')
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'

const PRESS_CD = 7160; // lower album_id -> must win the artwork tie-break
const PRESS_LP = 7161; // higher album_id, same artist+album, distinct artwork

const ARTIST_NAME = 'BS88 Phase3 Probe Artist';
const ALBUM_TITLE = 'BS88 Phase3 Probe Album';
const RECORD_LABEL = 'BS88 Probe Records';

const CD_ARTWORK = 'https://i.discogs.com/bs88-phase3-cd.jpg';
const LP_ARTWORK = 'https://i.discogs.com/bs88-phase3-lp.jpg';

const ROTATION_ARTIST_NAME = 'BS88 Phase3 Rotation Artist';
const ROTATION_ALBUM_TITLE = 'BS88 Phase3 Rotation Album';
// Explicit id, not the serial default: this dev DB's rotation_id_seq trails
// well behind MAX(id) (a real prod-clone-vs-shape-fixture drift, unrelated
// to this change — see docs/dev-db-fixture.md), so a bare INSERT can collide
// with an existing high-id row. Reserved-range style, same rationale as
// PRESS_CD/PRESS_LP above.
const ROTATION_ID = 7170;

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

describe('GET /playlists/recentEntries (Phase 3 — Postgres-backed, WXYC/wiki#88)', () => {
  let sql;
  const flowsheetIds = [];
  const libraryIds = [PRESS_CD, PRESS_LP];
  let rotationId;

  beforeAll(async () => {
    sql = makeSql();

    // Split-format library rows for the artwork tie-break.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (${PRESS_CD}, ${ART}, ${GEN}, ${FMT}, ${ALBUM_TITLE}, 1160, ${ARTIST_NAME})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (${PRESS_LP}, ${ART}, ${GEN}, ${FMT}, ${ALBUM_TITLE}, 1161, ${ARTIST_NAME})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url)
      VALUES (${PRESS_CD}, ${CD_ARTWORK})
      ON CONFLICT (album_id) DO UPDATE SET artwork_url = EXCLUDED.artwork_url
    `;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url)
      VALUES (${PRESS_LP}, ${LP_ARTWORK})
      ON CONFLICT (album_id) DO UPDATE SET artwork_url = EXCLUDED.artwork_url
    `;

    // Library-unlinked rotation row (denormalized artist/album snapshot) —
    // active as of "now", so the rotationBinExpr fallback subquery
    // (flowsheet.rotation_id IS NULL, text match against rotation.artist_name
    // / rotation.album_title) picks it up for the probe track below.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation
        (id, rotation_bin, add_date, kill_date, artist_name, album_title)
      VALUES (${ROTATION_ID}, 'M', CURRENT_DATE - INTERVAL '30 days', NULL, ${ROTATION_ARTIST_NAME}, ${ROTATION_ALBUM_TITLE})
      ON CONFLICT (id) DO UPDATE SET
        rotation_bin = EXCLUDED.rotation_bin,
        add_date = EXCLUDED.add_date,
        kill_date = EXCLUDED.kill_date,
        artist_name = EXCLUDED.artist_name,
        album_title = EXCLUDED.album_title
    `;
    rotationId = ROTATION_ID;

    // Two split-format plays of the same artist+album (tie-break probe).
    const cdPlay = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, play_order, artist_name, album_title, track_title, record_label, album_id, request_flag)
      VALUES ('track', 91600, ${ARTIST_NAME}, ${ALBUM_TITLE}, 'Probe Track (CD press)', ${RECORD_LABEL}, ${PRESS_CD}, false)
      RETURNING id
    `;
    const lpPlay = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, play_order, artist_name, album_title, track_title, record_label, album_id, request_flag)
      VALUES ('track', 91601, ${ARTIST_NAME}, ${ALBUM_TITLE}, 'Probe Track (LP press)', ${RECORD_LABEL}, ${PRESS_LP}, true)
      RETURNING id
    `;

    // Hand-typed rotation match: artist+album text matches the rotation row
    // above, but rotation_id is left NULL — exercises the fallback cohort.
    const rotationMatchPlay = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, play_order, artist_name, album_title, track_title, request_flag)
      VALUES ('track', 91602, ${ROTATION_ARTIST_NAME}, ${ROTATION_ALBUM_TITLE}, 'Probe Track (hand-typed rotation match)', false)
      RETURNING id
    `;

    const talksetRow = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet (entry_type, play_order, message)
      VALUES ('talkset', 91603, 'BS88 probe talkset')
      RETURNING id
    `;
    const djJoinRow = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet (entry_type, play_order, dj_name)
      VALUES ('dj_join', 91604, 'BS88 Probe DJ')
      RETURNING id
    `;

    // Breakpoint logged ~1 minute before the top of the hour: radio_hour
    // must win over flooring add_time (BS#1448/#1449).
    const breakpointRow = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet (entry_type, play_order, add_time, radio_hour, message)
      VALUES ('breakpoint', 91605, '2026-07-28 19:59:12+00', '2026-07-28 20:00:00+00', 'BREAKPOINT')
      RETURNING id
    `;

    const showStartRow = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet (entry_type, play_order, dj_name)
      VALUES ('show_start', 91606, 'BS88 Probe DJ')
      RETURNING id
    `;
    const showEndRow = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet (entry_type, play_order, dj_name)
      VALUES ('show_end', 91607, 'BS88 Probe DJ')
      RETURNING id
    `;

    flowsheetIds.push(
      cdPlay[0].id,
      lpPlay[0].id,
      rotationMatchPlay[0].id,
      talksetRow[0].id,
      djJoinRow[0].id,
      breakpointRow[0].id,
      showStartRow[0].id,
      showEndRow[0].id
    );
  });

  afterAll(async () => {
    if (!sql) return;
    if (flowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${flowsheetIds})`;
    }
    if (rotationId != null) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ${rotationId}`;
    }
    await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${libraryIds})`;
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
    await sql.end();
  });

  test('groups playcuts/talksets/breakpoints and omits show_start/show_end', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    expect(res.headers['cache-control']).toBe('public, max-age=30');

    const playcutIds = res.body.playcuts.map((p) => p.id);
    const talksetIds = res.body.talksets.map((t) => t.id);
    const breakpointIds = res.body.breakpoints.map((b) => b.id);
    const allIds = [...playcutIds, ...talksetIds, ...breakpointIds];

    // show_start / show_end never appear in any output array.
    expect(allIds).not.toContain(flowsheetIds[6]); // showStartRow
    expect(allIds).not.toContain(flowsheetIds[7]); // showEndRow

    // dj_join and talkset both land in `talksets`.
    expect(talksetIds).toEqual(expect.arrayContaining([flowsheetIds[3], flowsheetIds[4]]));
    expect(breakpointIds).toContain(flowsheetIds[5]);
  });

  test('resolves both split-format plays to the lower album_id artwork (BS#1105 tie-break, end to end)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    const cdEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[0]);
    const lpEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[1]);

    expect(cdEntry).toBeDefined();
    expect(lpEntry).toBeDefined();
    // Both plays share the same lookup key -> both resolve to PRESS_CD's
    // artwork (the lower album_id), regardless of which press each play
    // itself links to.
    expect(cdEntry.artworkURL).toBe(CD_ARTWORK);
    expect(lpEntry.artworkURL).toBe(CD_ARTWORK);
  });

  test('emits request as a "true"/"false" string, not a boolean', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    const cdEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[0]);
    const lpEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[1]);

    expect(cdEntry.request).toBe('false');
    expect(lpEntry.request).toBe('true');
    expect(typeof cdEntry.request).toBe('string');
  });

  test('emits rotation as "true" via the fallback text-match subquery for a hand-typed entry with no rotation_id', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    const rotationMatchEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[2]);
    expect(rotationMatchEntry).toBeDefined();
    expect(rotationMatchEntry.rotation).toBe('true');

    // The split-format probes are NOT in rotation.
    const cdEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[0]);
    expect(cdEntry.rotation).toBe('false');
  });

  test('breakpoint hour uses radio_hour verbatim, not floor(add_time)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    const breakpointEntry = res.body.breakpoints.find((b) => b.id === flowsheetIds[5]);
    expect(breakpointEntry).toBeDefined();
    expect(breakpointEntry.hour).toBe(new Date('2026-07-28T20:00:00.000Z').getTime());
  });

  test('clamps n and returns 200 for the default/no-param case', async () => {
    const res = await request.get('/playlists/recentEntries').expect(200);
    expect(Array.isArray(res.body.playcuts)).toBe(true);
    expect(res.body.playcuts.length).toBeLessThanOrEqual(50);
  });
});
