/**
 * BS#2080 — the `rotation_bin` fallback in `FSEntryFieldsRaw`, against a real database.
 *
 * BS#2080 rewrote that fallback from a three-armed `OR` over one
 * LEFT-JOINed rotation/library/artists set into a `UNION ALL` of three
 * separately-indexable probes, because the OR spanned three tables and no
 * index could serve it (prod `GET /flowsheet/range` fit
 * `1.125s + 19.0ms * n_fallback`, and the 7-day window blew the 5s statement
 * timeout). The rewrite was verified equivalent against 1,030 real prod rows
 * before it shipped — but nothing in the suite pinned the three cohorts, so a
 * future edit could collapse an arm and only the badge would go quiet.
 *
 * This spec is that pin. It exercises each cohort independently through a real
 * read path, plus the add_date/kill_date window, the tie-break, and the
 * whitespace guard. It deliberately asserts through `GET /flowsheet/range`
 * rather than calling the service directly, so the projection is covered too.
 *
 * It also pins the BS#2183 decision sitting right next to the window it
 * contrasts with: the fallback subquery above is windowed against add_time,
 * but the primary `rotation_id` FK join is deliberately NOT — see the
 * "primary FK join is deliberately unwindowed" describe block below.
 *
 * The window is placed in 1997 — outside anything the shared dev/CI schema
 * seeds and outside the BS#2062 spec's 1998 window, so the two can run in the
 * same band without interfering. Everything written here is torn down in
 * afterAll.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// Genre + format ids that exist in the integration fixture (same constants the
// artist-unicode-dedup and library specs use).
const GENRE_ID = 11;
const FORMAT_ID = 1;

// Midnight ET on 1997-06-10 (EDT, UTC-4) and the following midnight.
const WINDOW_START = Date.UTC(1997, 5, 10, 4, 0, 0);
const WINDOW_END = Date.UTC(1997, 5, 11, 4, 0, 0);
const MARKER = 'BS2080 Fallback Probe';

const at = (offsetMs) => new Date(WINDOW_START + offsetMs).toISOString();
const MIN = 60 * 1000;

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

describe('rotation_bin fallback cohorts (BS#2080)', () => {
  let sql;
  let showId;
  const rotationIds = [];
  const libraryIds = [];
  const artistIds = [];
  const entryIds = {};
  let body;

  // add_date/kill_date are DATEs; the window sits inside this rotation stint.
  const ROT_ADD = '1997-06-01';
  const ROT_KILL = '1997-07-01';

  beforeAll(async () => {
    sql = makeSql();

    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (start_time, end_time, legacy_dj_name)
      VALUES (${at(0)}::timestamptz, ${at(180 * MIN)}::timestamptz, ${`${MARKER} dj`})
      RETURNING id`;
    showId = rows[0].id;

    const insertArtist = async (name) => {
      const r = await sql`
        INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
        VALUES (${name}, ${name}, 'ZZ') RETURNING id`;
      artistIds.push(r[0].id);
      return r[0].id;
    };

    const insertLibrary = async (artistId, title) => {
      const r = await sql`
        INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
        VALUES (${artistId}, ${GENRE_ID}, ${FORMAT_ID}, ${title}, ${libraryIds.length + 1}) RETURNING id`;
      libraryIds.push(r[0].id);
      return r[0].id;
    };

    const insertRotation = async ({
      albumId = null,
      artistName = null,
      albumTitle = null,
      bin,
      addDate = ROT_ADD,
      killDate = ROT_KILL,
    }) => {
      // Always RETURNING id — never recover the id with a SELECT on
      // artist_name. A run that crashed between beforeAll and afterAll leaves
      // a probe row behind; a name-based SELECT would then return rows in
      // unspecified order, teardown would record the stale id, and the new row
      // would leak and compound on every subsequent run.
      const r = await sql`
        INSERT INTO ${sql(SCHEMA)}.rotation (album_id, artist_name, album_title, rotation_bin, add_date, kill_date)
        VALUES (${albumId}, ${artistName}, ${albumTitle}, ${bin}, ${addDate}::date, ${killDate === null ? null : sql`${killDate}::date`})
        RETURNING id`;
      rotationIds.push(r[0].id);
      return r[0].id;
    };

    const insertEntry = async (
      key,
      offsetMs,
      { albumId = null, artistName = null, albumTitle = null, rotationId = null }
    ) => {
      const r = await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet
          (show_id, entry_type, add_time, play_order, album_id, artist_name, album_title, track_title, rotation_id)
        VALUES (
          ${showId}, 'track', ${at(offsetMs)}::timestamptz, ${Object.keys(entryIds).length + 1},
          ${albumId}, ${artistName}, ${albumTitle}, ${`${MARKER} ${key}`}, ${rotationId}
        )
        RETURNING id`;
      entryIds[key] = r[0].id;
      return r[0].id;
    };

    // --- cohort (a): flowsheet.album_id matches an active rotation.album_id ---
    // Every name in this spec carries the MARKER prefix, including these. The
    // un-prefixed `@wxyc/shared` example names would be separated from the
    // dev/CI seed only by the 1997 window, so a future seed row for the same
    // artist/album with an early enough add_date would silently start matching
    // through arm (b) or (c) and look like a fallback regression.
    const artistA = await insertArtist(`${MARKER} Chuquimamani-Condori`);
    const albumA = await insertLibrary(artistA, `${MARKER} Edits`);
    await insertRotation({ albumId: albumA, bin: 'H' });
    await insertEntry('cohortA', 10 * MIN, {
      albumId: albumA,
      artistName: `${MARKER} Chuquimamani-Condori`,
      albumTitle: `${MARKER} Edits`,
    });

    // --- cohort (b): rotation row's own denormalized (artist, album) snapshot ---
    // No library link at all; the rotation row carries the names directly.
    // Case and surrounding whitespace differ from the entry on purpose — the
    // match is lower(trim(...)) on both sides.
    await insertRotation({
      artistName: `  ${MARKER.toUpperCase()} jUANA molina  `,
      albumTitle: '  dOGA  ',
      bin: 'M',
    });
    await insertEntry('cohortB', 20 * MIN, {
      artistName: `${MARKER} Juana Molina`,
      albumTitle: 'DOGA',
    });

    // --- cohort (c): names come from the library -> artists join ---
    // The rotation row is library-linked but its own denorm fields are NULL,
    // and the flowsheet entry is free-form (no album_id), so only the join can
    // resolve it. This is the arm that used to require a LEFT JOIN.
    const artistC = await insertArtist(`${MARKER} Jessica Pratt`);
    const albumC = await insertLibrary(artistC, `${MARKER} On Your Own Love Again`);
    await insertRotation({ albumId: albumC, bin: 'L' });
    await insertEntry('cohortC', 30 * MIN, {
      artistName: `${MARKER} Jessica Pratt`,
      albumTitle: `${MARKER} On Your Own Love Again`,
    });

    // --- kill_date is an exclusive upper bound ---
    await insertRotation({
      artistName: `${MARKER} Stereolab`,
      albumTitle: `${MARKER} Dots and Loops`,
      bin: 'S',
      killDate: '1997-06-05', // killed BEFORE the window
    });
    await insertEntry('killedBefore', 40 * MIN, {
      artistName: `${MARKER} Stereolab`,
      albumTitle: `${MARKER} Dots and Loops`,
    });

    // --- add_date is an inclusive lower bound: a play that aired before the
    //     release entered rotation is not badged (BS#1526) ---
    await insertRotation({
      artistName: `${MARKER} Cat Power`,
      albumTitle: `${MARKER} Moon Pix`,
      bin: 'H',
      addDate: '1997-06-20', // entered rotation AFTER the window
      killDate: null,
    });
    await insertEntry('addedLater', 50 * MIN, {
      artistName: `${MARKER} Cat Power`,
      albumTitle: `${MARKER} Moon Pix`,
    });

    // --- PRIMARY FK JOIN IS DELIBERATELY UNWINDOWED (BS#2183) ---
    // Everything above windows the FALLBACK subquery against add_time. The
    // primary `leftJoin(rotation, rotation.id = flowsheet.rotation_id)` in
    // flowsheet.service.ts has no window at all: an explicit rotation_id is
    // the writer's assertion (BS#1268 stamps it from the tubafrenzy webhook;
    // the dj-site rotation picker emits it) and outranks date arithmetic. These
    // two fixtures reuse the exact `killedBefore`/`addedLater` bounds above,
    // but set rotation_id, to prove the FK path badges through the very window
    // the fallback enforces.
    const fkKilledArtist = await insertArtist(`${MARKER} Nilüfer Yanya`);
    const fkKilledAlbum = await insertLibrary(fkKilledArtist, `${MARKER} Painless`);
    const fkKilledRotation = await insertRotation({
      albumId: fkKilledAlbum,
      bin: 'H',
      killDate: '1997-06-05', // killed BEFORE the window, same bound as `killedBefore` above
    });
    await insertEntry('fkKilledBeforeKillDate', 110 * MIN, {
      albumId: fkKilledAlbum,
      artistName: `${MARKER} Nilüfer Yanya`,
      albumTitle: `${MARKER} Painless`,
      rotationId: fkKilledRotation,
    });

    const fkEarlyArtist = await insertArtist(`${MARKER} Hermanos Gutiérrez`);
    const fkEarlyAlbum = await insertLibrary(fkEarlyArtist, `${MARKER} El Bueno y El Malo`);
    const fkEarlyRotation = await insertRotation({
      albumId: fkEarlyAlbum,
      bin: 'M',
      addDate: '1997-06-20', // entered rotation AFTER the window, same bound as `addedLater` above
      killDate: null,
    });
    await insertEntry('fkAiredBeforeAddDate', 115 * MIN, {
      albumId: fkEarlyAlbum,
      artistName: `${MARKER} Hermanos Gutiérrez`,
      albumTitle: `${MARKER} El Bueno y El Malo`,
      rotationId: fkEarlyRotation,
    });

    // --- tie-break: two active rows for the same (artist, album), lowest id wins ---
    const firstBin = await insertRotation({
      artistName: `${MARKER} Duke Ellington`,
      albumTitle: `${MARKER} Sentimental Mood`,
      bin: 'L',
    });
    await insertRotation({
      artistName: `${MARKER} Duke Ellington`,
      albumTitle: `${MARKER} Sentimental Mood`,
      bin: 'H',
    });
    expect(firstBin).toBeLessThan(rotationIds[rotationIds.length - 1]);
    await insertEntry('tieBreak', 60 * MIN, {
      artistName: `${MARKER} Duke Ellington`,
      albumTitle: `${MARKER} Sentimental Mood`,
    });

    // --- CROSS-ARM tie-break: lowest id wins ACROSS arms, not within one ---
    // The pre-BS#2080 form ORed the arms into a single scan, so one `ORDER BY
    // r2.id LIMIT 1` covered everything. The UNION ALL form has to sort the
    // union, and a future edit that pushed ORDER BY/LIMIT down into an arm, or
    // dropped `r2.id` from an arm's SELECT list, would still satisfy every
    // single-arm assertion above. Here the LOW id is reachable only by arm (b)
    // and the HIGH id only by arm (a), so the lowest-across-arms invariant is
    // the only thing that produces 'S'.
    const crossArtist = await insertArtist(`${MARKER} Stereolab Cross`);
    const crossAlbum = await insertLibrary(crossArtist, `${MARKER} Cross Album`);
    const lowIdArmB = await insertRotation({
      artistName: `${MARKER} Cross Artist`,
      albumTitle: `${MARKER} Cross Title`,
      bin: 'S',
    });
    const highIdArmA = await insertRotation({ albumId: crossAlbum, bin: 'H' });
    expect(lowIdArmB).toBeLessThan(highIdArmA);
    await insertEntry('crossArm', 80 * MIN, {
      albumId: crossAlbum, // arm (a) -> highIdArmA ('H')
      artistName: `${MARKER} Cross Artist`, // arm (b) -> lowIdArmB ('S')
      albumTitle: `${MARKER} Cross Title`,
    });

    // --- one rotation row reachable by TWO arms appears twice in the union ---
    // A library-linked row whose denormalized fields ALSO match the entry is
    // emitted by both arm (a) and arm (b). The comment at the subquery says
    // `LIMIT 1` makes the duplicate harmless; nothing tested it.
    const dupArtist = await insertArtist(`${MARKER} Dup Artist`);
    const dupAlbum = await insertLibrary(dupArtist, `${MARKER} Dup Album`);
    await insertRotation({
      albumId: dupAlbum,
      artistName: `${MARKER} Dup Artist`,
      albumTitle: `${MARKER} Dup Album`,
      bin: 'L',
    });
    await insertEntry('doubleMatch', 90 * MIN, {
      albumId: dupAlbum,
      artistName: `${MARKER} Dup Artist`,
      albumTitle: `${MARKER} Dup Album`,
    });

    // --- REGRESSION GUARD (the bug this PR's first revision shipped) ---
    // Real artist, BLANK album title, album_id SET. Arm (a) matches on
    // album_id and never reads the text, so this MUST still badge. An earlier
    // revision tightened the outer guard to `trim(coalesce(col,'')) <> ''` to
    // justify arm 3's inner JOIN — but that guard gates all three arms, so it
    // silently dropped this badge. Verified against the clone before the
    // revert: album_id 36962 returned 'M' under the original guard and nothing
    // under the tightened one.
    const guardArtist = await insertArtist(`${MARKER} Guard Artist`);
    const guardAlbum = await insertLibrary(guardArtist, `${MARKER} Guard Album`);
    await insertRotation({ albumId: guardAlbum, bin: 'H' });
    await insertEntry('blankAlbumWithAlbumId', 100 * MIN, {
      albumId: guardAlbum,
      artistName: `${MARKER} Guard Artist`,
      albumTitle: '   ', // blank but non-empty: passes the guard, ignored by arm (a)
    });

    // --- blank artist AND album: the one intended behaviour change ---
    // This entry passes the (deliberately untrimmed) outer guard, trims to ''
    // inside the subquery, and under the OLD arm-3 LEFT JOIN matched the
    // NULL side of every library-less active rotation row — cohortB's row is
    // exactly one — handing back its bin as a badge. Arm 3's inner JOIN drops
    // those rows, so the correct answer is no badge.
    //
    // Deterministic because the 1997 window is rotation-quiet: 0 active
    // rotation rows exist there in the dev clone or the CI seed, so the only
    // candidates are this spec's own fixtures, none of which are blank-named.
    await insertEntry('whitespace', 70 * MIN, { artistName: '   ', albumTitle: '   ' });

    const res = await request.get('/flowsheet/range').query({ start: WINDOW_START, end: WINDOW_END });
    expect(res.status).toBe(200);
    body = res.body;
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = Object.values(entryIds);
    if (ids.length) await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${ids})`;
    if (showId) await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE id = ${showId}`;
    if (rotationIds.length) await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${rotationIds})`;
    if (libraryIds.length) await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
    if (artistIds.length) await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ANY(${artistIds})`;
    await sql.end({ timeout: 5 });
  });

  const binOf = (key) => {
    const entry = body.entries.find((e) => e.id === entryIds[key]);
    expect(entry).toBeDefined();
    return entry.rotation_bin ?? null;
  };

  it.each([
    ['cohortA', 'album_id matches an active rotation row', 'H'],
    ['cohortB', "rotation row's own denormalized artist/album snapshot", 'M'],
    ['cohortC', 'artist/album resolved through the library -> artists join', 'L'],
  ])('badges %s via %s', (key, _why, expected) => {
    expect(binOf(key)).toBe(expected);
  });

  it.each([
    ['killedBefore', 'kill_date is an exclusive upper bound'],
    ['addedLater', 'add_date is an inclusive lower bound (BS#1526)'],
  ])('leaves %s unbadged — %s', (key) => {
    expect(binOf(key)).toBeNull();
  });

  describe('primary FK join is deliberately unwindowed (BS#2183)', () => {
    // CHARACTERIZATION TESTS, not TDD red-then-green: this behavior already
    // exists today and both assertions below pass on first run. That is
    // correct and expected — the point isn't to drive new behavior, it's to
    // pin the BS#2183 decision so it fails loudly if someone later "fixes"
    // the primary FK join by bolting the fallback's add_date/kill_date window
    // onto it without reading that decision first. See the
    // FSEntryFieldsRaw.rotation_bin comment and the four
    // `.leftJoin(rotation, ...)` call sites in flowsheet.service.ts.

    it('badges via the FK even when the linked rotation record was killed before the entry aired', () => {
      // Same kill_date/window shape as the fallback's `killedBefore` case
      // above — but here rotation_id is SET. Absent the FK, the fallback
      // would exclude this row (kill_date is not > add_time) and the badge
      // would be null, exactly as `killedBefore` proves above. With the FK
      // set, the primary join wins and the badge survives.
      expect(binOf('fkKilledBeforeKillDate')).toBe('H');
    });

    it("badges via the FK even when the entry aired before the rotation record's add_date", () => {
      // Same add_date/window shape as the fallback's `addedLater` case
      // above — but here rotation_id is SET. Absent the FK, the fallback
      // would exclude this row (add_date > add_time) and the badge would be
      // null, exactly as `addedLater` proves above.
      expect(binOf('fkAiredBeforeAddDate')).toBe('M');
    });
  });

  it('badges a blank artist+album via arm (b), which shadows the arm (c) join change', () => {
    // Worth stating plainly, because it is the reason this PR is observationally
    // equivalent rather than "equivalent except for one edge case".
    //
    // A blank entry trims to '' on both sides. Arm (b) compares against
    // `lower(trim(coalesce(r2.artist_name, '')))`, and a LIBRARY-LINKED rotation
    // row carries NULL denormalized names — which coalesce to ''. So arm (b)
    // matches, and returns the lowest-id such row: cohortA's ('H').
    //
    // That happens identically before and after BS#2080, because arm (b) is
    // untouched. The arm (c) LEFT JOIN -> inner JOIN change can therefore only
    // be observed in a window that has a library-LESS active rotation row with
    // non-blank names AND no blank-named row at all — cohortB's shape, alone.
    // No such window exists in this fixture set, and none was found in 7 days
    // of prod (the 1,030-row equivalence diff returned zero disagreements).
    expect(binOf('whitespace')).toBe('H');
  });

  it('still badges a blank album_title when album_id matches (arm (a) ignores the text)', () => {
    // The regression guard. If the outer guard is ever tightened to
    // `trim(coalesce(col,'')) <> ''` again, this is the test that fails.
    expect(binOf('blankAlbumWithAlbumId')).toBe('H');
  });

  it('breaks a tie on the lowest rotation id, not the newest bin', () => {
    // Two active rows match; the older (lowest id) carries 'L'. Reporting the
    // original cohort rather than flipping retroactively is the deliberate
    // choice documented at the subquery.
    expect(binOf('tieBreak')).toBe('L');
  });

  it('breaks a tie on the lowest id ACROSS arms, not within a single arm', () => {
    // arm (b) holds the low id ('S'), arm (a) the high id ('H'). Only a sort
    // over the whole union produces 'S'; pushing ORDER BY/LIMIT into an arm,
    // or dropping r2.id from an arm's SELECT, yields 'H' here while every
    // single-arm test above still passes.
    expect(binOf('crossArm')).toBe('S');
  });

  it('handles one rotation row matched by two arms (duplicate row in the union)', () => {
    // Emitted by both arm (a) and arm (b); ORDER BY … LIMIT 1 makes the
    // duplicate harmless rather than a cardinality error.
    expect(binOf('doubleMatch')).toBe('L');
  });
});
