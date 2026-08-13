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
 * rationale). fetchRecentRows orders by `add_time DESC, id DESC` (BS#2132 —
 * previously `id DESC` alone, which let a historical `add_time` silently
 * ride in on the id PK), so EVERY fixture row below — including the
 * breakpoint, which used to set `add_time` explicitly to a hard-coded past
 * date — takes the `add_time` DEFAULT (`now()`). See the breakpoint
 * fixture's own comment for why even a small, JS-computed backdating
 * still isn't safe here.
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

// BS#2103 metadata-enrichment probe: a diacritic-bearing artist (Nilüfer Yanya,
// from wxyc-shared/src/test-utils/wxyc-example-data.json) with a fully
// populated album_metadata row, plus two deliberate hazards the serializer has
// to defuse:
//   - `spotify_url` holding a NON-Spotify host (mislabeled at the LML boundary
//     before #1712 — the BS#1714 guard must null it);
//   - `discogs_url` holding the '' synthetic-match sentinel LML persists
//     (LML#401/#487 — the projection NULLIFs it, BS#1628).
// The wire keys are camelCase here, unlike /flowsheet's snake_case: iOS 3.2's
// `Playcut` CodingKeys are the SSOT (wxyc-ios-64 @ v3.2-AppStoreSubmission4).
const ENRICHED_LIB_ID = 7163;
const ENRICHED_ARTIST = 'Nilüfer Yanya';
const ENRICHED_ALBUM = 'PAINLESS';
const ENRICHED_ARTWORK = 'https://i.discogs.com/bs2103-painless.jpg';
const ENRICHED_DISCOGS = 'https://www.discogs.com/release/22012345';
const ENRICHED_APPLE = 'https://music.apple.com/us/album/painless/1609094304';
const ENRICHED_YOUTUBE = 'https://music.youtube.com/playlist?list=OLAK5uy_bs2103';
const ENRICHED_BANDCAMP = 'https://niluferyanya.bandcamp.com/album/painless';
const ENRICHED_SOUNDCLOUD = 'https://soundcloud.com/niluferyanya/stabilise';
const ENRICHED_WIKIPEDIA = 'https://en.wikipedia.org/wiki/Nil%C3%BCfer_Yanya';
const ENRICHED_BIO = 'Nilüfer Yanya is a London-born singer-songwriter.';
// A Bandcamp URL filed under spotify_url — must be suppressed, not emitted.
const MISLABELED_SPOTIFY = 'https://niluferyanya.bandcamp.com/album/painless';

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
  const libraryIds = [PRESS_CD, PRESS_LP, BRANCHA_LIB_ID, BRANCHC_LIB_ID, ENRICHED_LIB_ID];
  const rotationIds = [];
  // Set by beforeAll from the INSERT's own RETURNING radio_hour (never
  // recomputed in JS) and read by the breakpoint-hour assertion below —
  // see the breakpointRow fixture comment for why (BS#2132).
  let breakpointHourMs;

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

    // BS#2103 enrichment probe: library row + a fully populated album_metadata
    // row, including the two hazards described at the constants above.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, discogs_unavailable)
      VALUES (${ENRICHED_LIB_ID}, ${ART}, ${GEN}, ${FMT}, ${ENRICHED_ALBUM}, 1163, ${ENRICHED_ARTIST}, false)
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, discogs_url, release_year, spotify_url, apple_music_url, youtube_music_url,
         bandcamp_url, soundcloud_url, artist_bio, artist_wikipedia_url, genres, styles)
      VALUES (${ENRICHED_LIB_ID}, ${ENRICHED_ARTWORK}, '', 2022, ${MISLABELED_SPOTIFY}, ${ENRICHED_APPLE},
              ${ENRICHED_YOUTUBE}, ${ENRICHED_BANDCAMP}, ${ENRICHED_SOUNDCLOUD}, ${ENRICHED_BIO},
              ${ENRICHED_WIKIPEDIA}, ${sql.array(['Rock'])}, ${sql.array(['Indie Rock', 'Art Rock'])})
      ON CONFLICT (album_id) DO UPDATE SET
        artwork_url = EXCLUDED.artwork_url,
        discogs_url = EXCLUDED.discogs_url,
        release_year = EXCLUDED.release_year,
        spotify_url = EXCLUDED.spotify_url,
        apple_music_url = EXCLUDED.apple_music_url,
        youtube_music_url = EXCLUDED.youtube_music_url,
        bandcamp_url = EXCLUDED.bandcamp_url,
        soundcloud_url = EXCLUDED.soundcloud_url,
        artist_bio = EXCLUDED.artist_bio,
        artist_wikipedia_url = EXCLUDED.artist_wikipedia_url,
        genres = EXCLUDED.genres,
        styles = EXCLUDED.styles
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

    // BS#2103: the enrichment probe play, linked to ENRICHED_LIB_ID.
    const enrichedPlay = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, play_order, artist_name, album_title, track_title, record_label, album_id, request_flag, metadata_status)
      VALUES ('track', 91611, ${ENRICHED_ARTIST}, ${ENRICHED_ALBUM}, 'stabilise', 'ATO Records', ${ENRICHED_LIB_ID}, false, 'enriched_match')
      RETURNING id
    `;

    // BS#2103: an unenriched free-text play — no album_id, so no library and no
    // album_metadata row, and every inline metadata column NULL. Proves the
    // no-enrichment payload carries no URL key at all (never `""`).
    const unenrichedPlay = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, play_order, artist_name, album_title, track_title, request_flag)
      VALUES ('track', 91612, 'BS2103 Unenriched Artist', 'BS2103 Unenriched Album', 'Probe Track (no metadata)', false)
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
    //
    // BS#2132: fetchRecentRows now orders by add_time DESC (not the
    // flowsheet.id PK), so this row MUST stay recent — an absolute
    // backdated add_time (this used to be a hard-coded 2026-07-28 literal)
    // silently falls out of the top-N window as soon as it ages past
    // whatever else lands in the table, exactly the id-DESC-reliance bug
    // BS#2132 fixed. Sibling integration specs insert their own flowsheet
    // rows on the add_time DEFAULT (now()) throughout the same --runInBand
    // run, so this row has to compete with a genuinely large, run-to-run-
    // variable population for a place in the 200-row window.
    //
    // Two earlier attempts tried to out-run that population by backdating
    // add_time by a shrinking margin (first to a real calendar hour
    // boundary — up to an hour stale — then to ~58s stale, computed in
    // JS). Both were proven flaky against real CI, not just locally: any
    // nonzero backdating is a race against however many sibling rows
    // land in that window during the run, which is nondeterministic run
    // to run. Worse, both computed the margin from the TEST RUNNER's
    // clock (`Date.now()`) while every sibling row's `now()` DEFAULT is
    // timestamped by the DATABASE container's clock — a second, compounding
    // source of drift on top of the shrinking margin itself.
    //
    // The actual fix: don't set add_time at all. Omitted from the INSERT,
    // it takes the DEFAULT `now()` — the same column, the same DATABASE
    // clock, the same freshness as every sibling row in this file. It
    // cannot lose the window on its own; if it ever does, every other row
    // in this fixture loses it too, which fails for an honest reason
    // instead of a timing coincidence. radio_hour is computed in the same
    // SQL statement, on the same clock, as the literal next hour boundary:
    // `date_trunc('hour', now()) + interval '1 hour'` — the "upcoming top
    // of hour" a breakpoint logged ~1 minute early carries in production.
    // A future radio_hour is harmless here: the SQL ordering only ever
    // reads add_time, never radio_hour (a pure display value —
    // computeHourMs — not a sort/filter key). floor(add_time) is
    // necessarily the CURRENT top of hour while radio_hour is the NEXT
    // one, so they always differ by exactly one hour and remain
    // distinguishable regardless of exactly when in the hour this runs.
    // RETURNING radio_hour makes the row itself the source of truth for
    // the assertion below, rather than recomputing it a second time.
    const breakpointRow = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet (entry_type, play_order, radio_hour, message)
      VALUES ('breakpoint', 91605, date_trunc('hour', now()) + interval '1 hour', 'BREAKPOINT')
      RETURNING id, radio_hour
    `;
    breakpointHourMs = breakpointRow[0].radio_hour.getTime();

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
      newlineArtistPlay[0].id, // [10]
      enrichedPlay[0].id, // [11] BS#2103 fully-enriched probe
      unenrichedPlay[0].id // [12] BS#2103 no-metadata probe
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
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

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
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

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
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const cdEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[0]);
    const lpEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[1]);

    expect(cdEntry.request).toBe('false');
    expect(lpEntry.request).toBe('true');
    expect(typeof cdEntry.request).toBe('string');
  });

  test('emits rotation as "true" via the fallback text-match query for a hand-typed entry with no rotation_id (branch b)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const rotationMatchEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[2]);
    expect(rotationMatchEntry).toBeDefined();
    expect(rotationMatchEntry.rotation).toBe('true');

    // The split-format probes are NOT in rotation.
    const cdEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[0]);
    expect(cdEntry.rotation).toBe('false');
  });

  test('emits rotation as "true" via the album_id branch for a hand-typed entry whose text matches no rotation (branch a, BS#1862)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const albumIdMatchEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[8]);
    expect(albumIdMatchEntry).toBeDefined();
    // rotation_id is NULL and the artist/album text matches no rotation row —
    // the only path to a badge is `flowsheet.album_id = rotation.album_id`.
    expect(albumIdMatchEntry.rotation).toBe('true');
  });

  test('emits rotation as "true" via the rotation->library->artists branch for a hand-typed entry with no album_id (branch c, BS#1862)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const libraryLinkedEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[9]);
    expect(libraryLinkedEntry).toBeDefined();
    // album_id is NULL (no branch a) and the rotation row's own artist/album
    // are NULL (no branch b) — the match can only come from the rotation's
    // linked library row joined to its artist.
    expect(libraryLinkedEntry.rotation).toBe('true');
  });

  test('does NOT badge a rotation-text match whose artist has a trailing newline (JS-vs-SQL trim parity, BS#1862)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const newlineEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[10]);
    expect(newlineEntry).toBeDefined();
    // Postgres trim() keeps the newline on both the candidate and rotation
    // sides, so 'bs88 phase3 rotation artist\n' != 'bs88 phase3 rotation artist'
    // -> no branch-b match, exactly as the original subquery. Would be 'true'
    // if the candidate side were normalized in JS (`.trim()` strips newlines).
    expect(newlineEntry.rotation).toBe('false');
  });

  test('breakpoint hour uses radio_hour verbatim, not floor(add_time)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const breakpointEntry = res.body.breakpoints.find((b) => b.id === flowsheetIds[5]);
    expect(breakpointEntry).toBeDefined();
    expect(breakpointEntry.hour).toBe(breakpointHourMs);
  });

  test('v=2 defaults to <=50 playcuts and returns the grouped object', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2 }).expect(200);
    expect(Array.isArray(res.body.playcuts)).toBe(true);
    expect(res.body.playcuts.length).toBeLessThanOrEqual(50);
  });

  // --- v=2 metadata enrichment (BS#2103) ---
  //
  // Shipped iOS 3.2 reads THIS endpoint (via the wxyc.info proxy) and already
  // decodes the full metadata set; the server just never sent it. These tests
  // are key-name-exact on purpose: a wrong name fails silently on the client
  // (JSONDecoder drops the key), so the camelCase names — and the two
  // deliberate snake_case exceptions — are asserted literally.

  test('a fully-enriched playcut carries the metadata under the iOS 3.2 camelCase keys', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const entry = res.body.playcuts.find((p) => p.id === flowsheetIds[11]);
    expect(entry).toBeDefined();
    // Diacritic survives the round trip byte-for-byte.
    expect(entry.artistName).toBe(ENRICHED_ARTIST);
    expect(entry.artworkURL).toBe(ENRICHED_ARTWORK);
    expect(entry.releaseYear).toBe(2022);
    expect(entry.appleMusicURL).toBe(ENRICHED_APPLE);
    expect(entry.youtubeMusicURL).toBe(ENRICHED_YOUTUBE);
    expect(entry.bandcampURL).toBe(ENRICHED_BANDCAMP);
    expect(entry.soundcloudURL).toBe(ENRICHED_SOUNDCLOUD);
    expect(entry.artistBio).toBe(ENRICHED_BIO);
    expect(entry.artistWikipediaURL).toBe(ENRICHED_WIKIPEDIA);
    expect(entry.genres).toEqual(['Rock']);
    expect(entry.styles).toEqual(['Indie Rock', 'Art Rock']);
    expect(entry.artistId).toBe(ART);
    // Key camelCase, VALUE snake_case — the raw MetadataStatus enum.
    expect(entry.metadataStatus).toBe('enriched_match');
    expect(entry.discogsUnavailable).toBe(false);
  });

  test("suppresses a spotify_url whose host isn't Spotify (BS#1714, end to end)", async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const entry = res.body.playcuts.find((p) => p.id === flowsheetIds[11]);
    // The persisted value is a Bandcamp URL mislabeled as Spotify; it must not
    // reach the hardwired iOS "Spotify" button.
    expect(entry.spotifyURL).toBeUndefined();
    // The correctly-hosted Bandcamp sibling is unaffected.
    expect(entry.bandcampURL).toBe(ENRICHED_BANDCAMP);
  });

  test("never emits the '' discogs synthetic-match sentinel as a URL (BS#1628 + the throwing iOS URL decode)", async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const entry = res.body.playcuts.find((p) => p.id === flowsheetIds[11]);
    // `decodeIfPresent(URL.self, …)` THROWS on '' and would fail the whole
    // Playcut decode, blanking the playlist. The key must be absent entirely.
    expect(Object.prototype.hasOwnProperty.call(entry, 'discogsURL')).toBe(false);
  });

  test('a play with no metadata emits no URL keys at all — never ""', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const entry = res.body.playcuts.find((p) => p.id === flowsheetIds[12]);
    expect(entry).toBeDefined();
    for (const key of [
      'artworkURL',
      'discogsURL',
      'spotifyURL',
      'appleMusicURL',
      'youtubeMusicURL',
      'bandcampURL',
      'soundcloudURL',
      'artistWikipediaURL',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
    }
    expect(entry.releaseYear).toBeUndefined();
    expect(entry.artistBio).toBeUndefined();
    expect(entry.genres).toBeUndefined();
    expect(entry.artistId).toBeUndefined();
    // No library row -> the discogs-unavailable flag is omitted, not `false`.
    expect(Object.prototype.hasOwnProperty.call(entry, 'discogsUnavailable')).toBe(false);
    // `metadata_status` is NOT NULL on the table, but the wire key is
    // conditional (option-3 serve rule): with zero renderable inline fields it
    // is withheld, so shipped 3.2 keeps its live `/proxy/metadata/album`
    // fallback instead of short-circuiting a terminal status to an empty card.
    expect(Object.prototype.hasOwnProperty.call(entry, 'metadataStatus')).toBe(false);
  });

  test('metadata keys off the play’s own album_id, matching /flowsheet (artwork keeps its own lookup-key tie-break)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 2, n: 100 }).expect(200);

    const lpEntry = res.body.playcuts.find((p) => p.id === flowsheetIds[1]);
    // PRESS_LP's album_metadata row holds artwork ONLY, so the LP play gets no
    // streaming links even though its artwork resolves (via the BS#1105
    // lookup-key tie-break) to the CD press's row. The two resolutions are
    // deliberately independent: artwork keeps its historical semantics,
    // everything else uses /flowsheet's own-album_id projection.
    expect(lpEntry.artworkURL).toBe(CD_ARTWORK);
    expect(Object.prototype.hasOwnProperty.call(lpEntry, 'spotifyURL')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(lpEntry, 'discogsURL')).toBe(false);
  });

  // --- v=1 flat wire format (Android; BS#1866) ---

  test('v absent -> flat ARRAY (Android contract), with X-Last-Modified exposed', async () => {
    const res = await request.get('/playlists/recentEntries').query({ n: 100 }).expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.headers['x-last-modified']).toMatch(/^\d+$/);
    expect(Number(res.headers['x-last-modified'])).toBeGreaterThan(0);
    expect(res.headers['access-control-expose-headers']).toContain('X-Last-Modified');
  });

  test('flat: a track is a playcut entry with a nested playcut object', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 1, n: 100 }).expect(200);

    const cd = res.body.find((e) => e.id === flowsheetIds[0]);
    expect(cd).toBeDefined();
    expect(cd.entryType).toBe('playcut');
    expect(cd.playcut).toMatchObject({
      artistName: ARTIST_NAME,
      songTitle: 'Probe Track (CD press)',
      releaseTitle: ALBUM_TITLE,
      rotation: 'false',
      request: 'false',
      segue: 'false',
    });
  });

  test('flat: INCLUDES show_start/show_end as showDelimiter entries (unlike v=2)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 1, n: 100 }).expect(200);

    const showStart = res.body.find((e) => e.id === flowsheetIds[6]);
    const showEnd = res.body.find((e) => e.id === flowsheetIds[7]);
    expect(showStart).toBeDefined();
    expect(showEnd).toBeDefined();
    expect(showStart.entryType).toBe('showDelimiter');
    expect(showEnd.entryType).toBe('showDelimiter');
    expect(showStart.playcut).toBeUndefined();
  });

  test('flat: breakpoint carries entryType "breakpoint"; talkset/dj_join carry "talkset"', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 1, n: 100 }).expect(200);

    const bp = res.body.find((e) => e.id === flowsheetIds[5]);
    const talkset = res.body.find((e) => e.id === flowsheetIds[3]);
    const djJoin = res.body.find((e) => e.id === flowsheetIds[4]);
    expect(bp.entryType).toBe('breakpoint');
    expect(talkset.entryType).toBe('talkset');
    expect(djJoin.entryType).toBe('talkset');
  });

  test('flat: rotation badge resolves the same as v=2 (hand-typed branch-b match)', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 1, n: 100 }).expect(200);

    const rotationMatch = res.body.find((e) => e.id === flowsheetIds[2]);
    expect(rotationMatch.entryType).toBe('playcut');
    expect(rotationMatch.playcut.rotation).toBe('true');
  });

  test('flat: carries NONE of the BS#2103 enrichment — the Android contract is untouched', async () => {
    const res = await request.get('/playlists/recentEntries').query({ v: 1, n: 100 }).expect(200);

    // The fully-enriched probe: rich on v=2, bare here.
    const enriched = res.body.find((e) => e.id === flowsheetIds[11]);
    expect(enriched).toBeDefined();
    expect(Object.keys(enriched).sort()).toEqual(['chronOrderID', 'entryType', 'hour', 'id', 'playcut', 'timeCreated']);
    expect(Object.keys(enriched.playcut).sort()).toEqual([
      'artistName',
      'labelName',
      'releaseTitle',
      'request',
      'rotation',
      'segue',
      'songTitle',
    ]);
  });
});
