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
      killDate = ROT_KILL,
    }) => {
      const r = await sql`
        INSERT INTO ${sql(SCHEMA)}.rotation (album_id, artist_name, album_title, rotation_bin, add_date, kill_date)
        VALUES (${albumId}, ${artistName}, ${albumTitle}, ${bin}, ${ROT_ADD}::date, ${killDate === null ? null : sql`${killDate}::date`})
        RETURNING id`;
      rotationIds.push(r[0].id);
      return r[0].id;
    };

    const insertEntry = async (key, offsetMs, { albumId = null, artistName = null, albumTitle = null }) => {
      const r = await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet
          (show_id, entry_type, add_time, play_order, album_id, artist_name, album_title, track_title, rotation_id)
        VALUES (
          ${showId}, 'track', ${at(offsetMs)}::timestamptz, ${Object.keys(entryIds).length + 1},
          ${albumId}, ${artistName}, ${albumTitle}, ${`${MARKER} ${key}`}, NULL
        )
        RETURNING id`;
      entryIds[key] = r[0].id;
      return r[0].id;
    };

    // --- cohort (a): flowsheet.album_id matches an active rotation.album_id ---
    const artistA = await insertArtist(`${MARKER} Chuquimamani-Condori`);
    const albumA = await insertLibrary(artistA, `${MARKER} Edits`);
    await insertRotation({ albumId: albumA, bin: 'H' });
    await insertEntry('cohortA', 10 * MIN, {
      albumId: albumA,
      artistName: 'Chuquimamani-Condori',
      albumTitle: 'Edits',
    });

    // --- cohort (b): rotation row's own denormalized (artist, album) snapshot ---
    // No library link at all; the rotation row carries the names directly.
    // Case and surrounding whitespace differ from the entry on purpose — the
    // match is lower(trim(...)) on both sides.
    await insertRotation({ artistName: '  jUANA molina  ', albumTitle: '  dOGA  ', bin: 'M' });
    await insertEntry('cohortB', 20 * MIN, { artistName: 'Juana Molina', albumTitle: 'DOGA' });

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
    await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation (artist_name, album_title, rotation_bin, add_date, kill_date)
      VALUES (${`${MARKER} Cat Power`}, ${`${MARKER} Moon Pix`}, 'H', '1997-06-20'::date, NULL)`;
    const lateRot = await sql`
      SELECT id FROM ${sql(SCHEMA)}.rotation WHERE artist_name = ${`${MARKER} Cat Power`}`;
    rotationIds.push(lateRot[0].id);
    await insertEntry('addedLater', 50 * MIN, {
      artistName: `${MARKER} Cat Power`,
      albumTitle: `${MARKER} Moon Pix`,
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

    // --- whitespace-only artist+album must NOT badge (the BS#2080 guard) ---
    // Under the pre-BS#2080 guard (`coalesce(col,'') <> ''`) this passed, then
    // trimmed to '' inside the subquery and matched the LEFT-JOINed NULL side
    // of every library-less active rotation row — handing back the lowest-id
    // one as a badge. cohortB's row above is exactly such a row, so if the
    // guard ever loosens again this entry lights up and this test fails.
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
    ['whitespace', 'a whitespace-only artist+album never reaches the fallback'],
  ])('leaves %s unbadged — %s', (key) => {
    expect(binOf(key)).toBeNull();
  });

  it('breaks a tie on the lowest rotation id, not the newest bin', () => {
    // Two active rows match; the older (lowest id) carries 'L'. Reporting the
    // original cohort rather than flipping retroactively is the deliberate
    // choice documented at the subquery.
    expect(binOf('tieBreak')).toBe('L');
  });
});
