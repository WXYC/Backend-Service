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

// Branch (a) probe (BS#1862): a rotation linked purely by album_id, matched by
// a hand-typed play whose artist/album text does NOT match any rotation — so
// only `flowsheet.album_id = rotation.album_id` can classify it as rotation.
const ROTATION_ID_BRANCH_A = 7171;
// Dedicated album for the branch-(a) probe — distinct from PRESS_CD/PRESS_LP so
// the split-format probes (which link PRESS_CD) don't accidentally match this
// rotation via album_id and flip their expected rotation='false'.
const BRANCHA_LIB_ID = 7162;
const BRANCHA_ARTIST = 'BS88 BranchA Artist';
const BRANCHA_ALBUM = 'BS88 BranchA Album';

// Branch (c) probe (BS#1862): a rotation linked by album_id to a library row
// whose artist comes from the `artists` join — matched by a hand-typed play
// whose album_id is NULL (so branch a can't fire) and whose text matches the
// rotation row's OWN columns not at all (they're NULL, so branch b can't
// fire), leaving only rotation -> library -> artists text as the match path.
const ROTATION_ID_BRANCH_C = 7172;
const BRANCHC_ARTIST_ID = 7300;
const BRANCHC_LIB_ID = 7301;
const BRANCHC_ARTIST = 'BS88 BranchC Artist';
const BRANCHC_ALBUM = 'BS88 BranchC Album';

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
  const libraryIds = [PRESS_CD, PRESS_LP, BRANCHA_LIB_ID, BRANCHC_LIB_ID];
  const rotationIds = [];

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
    rotationIds.push(ROTATION_ID);

    // Branch (a): a dedicated library album + a rotation linked to it by
    // album_id only (no denormalized artist/album text). Distinct from the
    // split-format probes so they don't match this rotation.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (${BRANCHA_LIB_ID}, ${ART}, ${GEN}, ${FMT}, ${BRANCHA_ALBUM}, 1162, ${BRANCHA_ARTIST})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation
        (id, rotation_bin, add_date, kill_date, album_id)
      VALUES (${ROTATION_ID_BRANCH_A}, 'H', CURRENT_DATE - INTERVAL '30 days', NULL, ${BRANCHA_LIB_ID})
      ON CONFLICT (id) DO UPDATE SET
        rotation_bin = EXCLUDED.rotation_bin,
        add_date = EXCLUDED.add_date,
        kill_date = EXCLUDED.kill_date,
        album_id = EXCLUDED.album_id,
        artist_name = NULL,
        album_title = NULL
    `;
    rotationIds.push(ROTATION_ID_BRANCH_A);

    // Branch (c): a dedicated artist + library row, and a rotation linked to
    // that library row with NO denormalized artist/album text of its own — so
    // the only path from a hand-typed play to a badge is via the
    // rotation -> library -> artists join text.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (id, artist_name, alphabetical_name, code_letters)
      VALUES (${BRANCHC_ARTIST_ID}, ${BRANCHC_ARTIST}, ${BRANCHC_ARTIST}, 'XC')
      ON CONFLICT (id) DO UPDATE SET artist_name = EXCLUDED.artist_name
    `;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (id, artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (${BRANCHC_LIB_ID}, ${BRANCHC_ARTIST_ID}, ${GEN}, ${FMT}, ${BRANCHC_ALBUM}, 1301, ${BRANCHC_ARTIST})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation
        (id, rotation_bin, add_date, kill_date, album_id)
      VALUES (${ROTATION_ID_BRANCH_C}, 'L', CURRENT_DATE - INTERVAL '30 days', NULL, ${BRANCHC_LIB_ID})
      ON CONFLICT (id) DO UPDATE SET
        rotation_bin = EXCLUDED.rotation_bin,
        add_date = EXCLUDED.add_date,
        kill_date = EXCLUDED.kill_date,
        album_id = EXCLUDED.album_id,
        artist_name = NULL,
        album_title = NULL
    `;
    rotationIds.push(ROTATION_ID_BRANCH_C);

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

    // Branch (a): links album_id = BRANCHA_LIB_ID (the album ROTATION_ID_BRANCH_A
    // is in rotation on), rotation_id NULL. Its artist/album text also matches
    // the linked library row here, but the point is the album_id path fires —
    // branch (c) is exercised separately below with a text-only match.
    const albumIdRotationPlay = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, play_order, artist_name, album_title, track_title, album_id, request_flag)
      VALUES ('track', 91608, ${BRANCHA_ARTIST}, ${BRANCHA_ALBUM}, 'Probe Track (album_id rotation match)', ${BRANCHA_LIB_ID}, false)
      RETURNING id
    `;

    // Branch (c): album_id NULL (so branch a can't fire), artist/album text
    // matching the rotation ONLY through its library->artists link.
    const libraryLinkedRotationPlay = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, play_order, artist_name, album_title, track_title, request_flag)
      VALUES ('track', 91609, ${BRANCHC_ARTIST}, ${BRANCHC_ALBUM}, 'Probe Track (library-linked rotation match)', false)
      RETURNING id
    `;

    // Normalization-parity guard: same artist/album text as the branch-(b)
    // rotation but with a TRAILING NEWLINE in the artist. Postgres `trim()`
    // strips only spaces (not newlines), on BOTH the candidate and rotation
    // sides — so this must NOT match (rotation='false'), identical to the
    // original correlated subquery. A candidate normalized in JS (`.trim()`,
    // which strips the newline) would wrongly badge it 'true'. rotation_id +
    // album_id NULL so only the branch-(b) text path could ever fire.
    const newlineArtistPlay = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, play_order, artist_name, album_title, track_title, request_flag)
      VALUES ('track', 91610, ${`${ROTATION_ARTIST_NAME}\n`}, ${ROTATION_ALBUM_TITLE}, 'Probe Track (newline artist, no match)', false)
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
      cdPlay[0].id, // [0]
      lpPlay[0].id, // [1]
      rotationMatchPlay[0].id, // [2]
      talksetRow[0].id, // [3]
      djJoinRow[0].id, // [4]
      breakpointRow[0].id, // [5]
      showStartRow[0].id, // [6]
      showEndRow[0].id, // [7]
      albumIdRotationPlay[0].id, // [8]
      libraryLinkedRotationPlay[0].id, // [9]
      newlineArtistPlay[0].id // [10]
    );
  });

  afterAll(async () => {
    if (!sql) return;
    if (flowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${flowsheetIds})`;
    }
    if (rotationIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${rotationIds})`;
    }
    await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${libraryIds})`;
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
    // Delete the branch-(c) artist AFTER its library row (library.artist_id FK).
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${BRANCHC_ARTIST_ID}`;
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

  test('emits rotation as "true" via the fallback text-match query for a hand-typed entry with no rotation_id (branch b)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    const rotationMatchEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[2]);
    expect(rotationMatchEntry).toBeDefined();
    expect(rotationMatchEntry.rotation).toBe('true');

    // The split-format probes are NOT in rotation.
    const cdEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[0]);
    expect(cdEntry.rotation).toBe('false');
  });

  test('emits rotation as "true" via the album_id branch for a hand-typed entry whose text matches no rotation (branch a, BS#1862)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    const albumIdMatchEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[8]);
    expect(albumIdMatchEntry).toBeDefined();
    // rotation_id is NULL and the artist/album text matches no rotation row —
    // the only path to a badge is `flowsheet.album_id = rotation.album_id`.
    expect(albumIdMatchEntry.rotation).toBe('true');
  });

  test('emits rotation as "true" via the rotation->library->artists branch for a hand-typed entry with no album_id (branch c, BS#1862)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    const libraryLinkedEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[9]);
    expect(libraryLinkedEntry).toBeDefined();
    // album_id is NULL (no branch a) and the rotation row's own artist/album
    // are NULL (no branch b) — the match can only come from the rotation's
    // linked library row joined to its artist.
    expect(libraryLinkedEntry.rotation).toBe('true');
  });

  test('does NOT badge a rotation-text match whose artist has a trailing newline (JS-vs-SQL trim parity, BS#1862)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    const newlineEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[10]);
    expect(newlineEntry).toBeDefined();
    // Postgres trim() keeps the newline on both the candidate and rotation
    // sides, so 'bs88 phase3 rotation artist\n' != 'bs88 phase3 rotation artist'
    // -> no branch-b match, exactly as the original subquery. Would be 'true'
    // if the candidate side were normalized in JS (`.trim()` strips newlines).
    expect(newlineEntry.rotation).toBe('false');
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
