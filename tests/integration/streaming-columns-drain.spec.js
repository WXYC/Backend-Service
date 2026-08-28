/**
 * BS#2295 streaming-columns drain — cohort predicate + fill-null write,
 * against the live `album_metadata` table.
 *
 * The drain's whole safety argument is two claims about SQL that a mocked
 * driver cannot demonstrate:
 *
 *   1. The cohort predicate selects exactly the frozen shape — load-bearing
 *      match present, all five streaming columns null — and, critically, is
 *      NOT fooled by SQL's three-valued logic on the all-null row that is the
 *      common case.
 *   2. The write is fill-null AND all-or-nothing. If the live enrichment
 *      worker healed the row between enumeration and write (which the merged
 *      forward fix now makes possible on the album's next play), the UPDATE
 *      touches nothing rather than topping up the columns the worker left.
 *
 * Pure SQL — does NOT import `jobs/streaming-columns-drain/job.ts`. The
 * integration runner is babel-jest with no TS support (drizzle-orm + ts-jest
 * incompatibility; same constraint as
 * `enrichment-worker-cache-precheck.spec.js`), so the statements are mirrored
 * in `tests/utils/streaming-columns-drain.js` — one file, not one per spec.
 *
 * @see WXYC/Backend-Service#2295
 * @see WXYC/Backend-Service#1747
 */

const { getTestDb } = require('../utils/db');
const { isInCohort, countCohort, applyStreamingFill, SCHEMA } = require('../utils/streaming-columns-drain');

const ARTWORK = 'https://i.discogs.com/b1/cover.jpg';
const DISCOGS = 'https://www.discogs.com/release/2295';

/** A complete fill, shaped like `buildStreamingFill`'s LML-matched output. */
const FULL_FILL = {
  spotify_url: 'https://open.spotify.com/album/aluminum-tunes',
  apple_music_url: 'https://music.apple.com/album/aluminum-tunes',
  youtube_music_url: 'https://music.youtube.com/search?q=Stereolab%20Aluminum%20Tunes',
  bandcamp_url: 'https://bandcamp.com/search?q=Stereolab%20Aluminum%20Tunes',
  soundcloud_url: 'https://soundcloud.com/search?q=Stereolab',
  spotify_status: null,
  apple_music_status: null,
};

/** The no-match fill: three synthesized URLs, spotify/apple deliberately null. */
const SYNTH_ONLY_FILL = {
  spotify_url: null,
  apple_music_url: null,
  youtube_music_url: FULL_FILL.youtube_music_url,
  bandcamp_url: FULL_FILL.bandcamp_url,
  soundcloud_url: FULL_FILL.soundcloud_url,
  spotify_status: null,
  apple_music_status: null,
};

/** A matched-but-empty fill: LML found the release but neither streaming
 * service, so both statuses go to `'unresolved'` for the BS#1915 sweep. */
const MATCHED_EMPTY_FILL = {
  ...SYNTH_ONLY_FILL,
  spotify_status: 'unresolved',
  apple_music_status: 'unresolved',
};

async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'b2295-drain-album-' + suffix}, 9999, 'Stereolab')
    RETURNING id
  `;
  return rows[0].id;
}

async function readStreaming(sql, albumId) {
  const rows = await sql`
    SELECT spotify_url, apple_music_url, youtube_music_url, bandcamp_url, soundcloud_url,
           spotify_status, apple_music_status, artwork_url, discogs_url
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ${albumId}
  `;
  return rows[0];
}

describe('BS#2295 streaming-columns drain — cohort predicate (real PG)', () => {
  let sql;
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  test.each([
    ['artwork-only', ARTWORK, null],
    ['discogs-only', null, DISCOGS],
    ['both-load-bearing', ARTWORK, DISCOGS],
  ])('IN COHORT: %s with all five streaming columns NULL', async (slug, artworkUrl, discogsUrl) => {
    const albumId = await insertLibraryAlbum(sql, slug);
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, discogs_url, updated_at)
      VALUES (${albumId}, ${artworkUrl}, ${discogsUrl}, NOW())
    `;

    expect(await isInCohort(sql, albumId)).toBe(true);
  });

  test.each([
    ['spotify_url', FULL_FILL.spotify_url],
    ['apple_music_url', FULL_FILL.apple_music_url],
    ['youtube_music_url', FULL_FILL.youtube_music_url],
    ['bandcamp_url', FULL_FILL.bandcamp_url],
    ['soundcloud_url', FULL_FILL.soundcloud_url],
  ])('NOT IN COHORT: a single populated %s is enough to disqualify the row', async (column, url) => {
    // Pinned one column at a time: the predicate must be an AND over all five,
    // not a check of whichever one a reader happened to think of. A row with
    // any streaming link is already serving something and is not frozen.
    const albumId = await insertLibraryAlbum(sql, 'has-' + column);
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, ${sql(column)}, updated_at)
      VALUES (${albumId}, ${ARTWORK}, ${url}, NOW())
    `;

    expect(await isInCohort(sql, albumId)).toBe(false);
  });

  test('NOT IN COHORT: no load-bearing match — the BS#1089 search-URL-only shell is a different defect', async () => {
    // That shell has streaming columns and no artwork/discogs; it is the
    // poisoned no-match the pre-check already re-opens on its own. Draining it
    // here would be writing over the very columns it already has.
    const albumId = await insertLibraryAlbum(sql, 'search-shell');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, spotify_url, updated_at)
      VALUES (${albumId}, ${FULL_FILL.spotify_url}, NOW())
    `;

    expect(await isInCohort(sql, albumId)).toBe(false);
  });

  test('NOT IN COHORT: an entirely empty row — nothing to drain, and no identity to trust', async () => {
    const albumId = await insertLibraryAlbum(sql, 'all-null');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, release_year, updated_at)
      VALUES (${albumId}, 1997, NOW())
    `;

    expect(await isInCohort(sql, albumId)).toBe(false);
  });

  test('countCohort moves by exactly one when one row enters the shape', async () => {
    const before = await countCohort(sql);
    const albumId = await insertLibraryAlbum(sql, 'count-delta');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, updated_at)
      VALUES (${albumId}, ${ARTWORK}, NOW())
    `;

    expect(await countCohort(sql)).toBe(before + 1);
  });
});

describe('BS#2295 streaming-columns drain — the fill-null write (real PG)', () => {
  let sql;
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
  });

  async function seedFrozen(sql, suffix) {
    const albumId = await insertLibraryAlbum(sql, suffix);
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, updated_at)
      VALUES (${albumId}, ${ARTWORK}, NOW())
    `;
    return albumId;
  }

  test('a full fill writes all five and takes the row out of the cohort', async () => {
    const albumId = await seedFrozen(sql, 'full-fill');
    expect(await isInCohort(sql, albumId)).toBe(true);

    expect(await applyStreamingFill(sql, albumId, FULL_FILL)).toBe(true);

    const row = await readStreaming(sql, albumId);
    expect(row.spotify_url).toBe(FULL_FILL.spotify_url);
    expect(row.apple_music_url).toBe(FULL_FILL.apple_music_url);
    expect(row.youtube_music_url).toBe(FULL_FILL.youtube_music_url);
    expect(await isInCohort(sql, albumId)).toBe(false);
  });

  test('a synthesized-only fill still takes the row out of the cohort, spotify/apple left null', async () => {
    // The no-match path, and the reason the drain converges: even with nothing
    // from LML, three columns come from our own library text, so the row
    // stops being frozen. Spotify/apple stay null on purpose (BS#1184/#1192).
    const albumId = await seedFrozen(sql, 'synth-only');

    expect(await applyStreamingFill(sql, albumId, SYNTH_ONLY_FILL)).toBe(true);

    const row = await readStreaming(sql, albumId);
    expect(row.spotify_url).toBeNull();
    expect(row.apple_music_url).toBeNull();
    expect(row.bandcamp_url).toBe(SYNTH_ONLY_FILL.bandcamp_url);
    expect(await isInCohort(sql, albumId)).toBe(false);
  });

  test('the identity columns are never touched — a mis-resolved lookup cannot move the album', async () => {
    // The load-bearing safety property. LML resolves by SEARCH and can land on
    // a different release; the drain writes no artwork/discogs, so the worst
    // case is a wrong link, never a wrong album.
    const albumId = await seedFrozen(sql, 'identity-untouched');
    await applyStreamingFill(sql, albumId, FULL_FILL);

    const row = await readStreaming(sql, albumId);
    expect(row.artwork_url).toBe(ARTWORK);
    expect(row.discogs_url).toBeNull();
  });

  test('TOCTOU: a row the live worker healed first is left completely alone, not topped up', async () => {
    // The forward fix means the enrichment worker now re-opens these rows on
    // the album's next play, so this race is live, not theoretical. The write
    // must be all-or-nothing: partially topping up a row the worker is midway
    // through writing would interleave two writers' values on one album.
    const albumId = await seedFrozen(sql, 'toctou');
    await sql`
      UPDATE ${sql(SCHEMA)}.album_metadata
         SET spotify_url = 'https://open.spotify.com/album/worker-won', updated_at = NOW()
       WHERE album_id = ${albumId}
    `;

    expect(await applyStreamingFill(sql, albumId, FULL_FILL)).toBe(false);

    const row = await readStreaming(sql, albumId);
    expect(row.spotify_url).toBe('https://open.spotify.com/album/worker-won');
    // The other four stay NULL: the drain declined the whole row rather than
    // filling the columns the worker had not reached yet.
    expect(row.apple_music_url).toBeNull();
    expect(row.youtube_music_url).toBeNull();
    expect(row.bandcamp_url).toBeNull();
    expect(row.soundcloud_url).toBeNull();
  });

  test('a matched-but-empty service is left unresolved, not NULL, so the BS#1915 sweep can re-ask', async () => {
    // A NULL status means "never consulted" and is explicitly NOT
    // re-ask-eligible (schema.ts), so writing the URLs and leaving the
    // statuses NULL would unfreeze the row from the cohort while freezing
    // Spotify/Apple a second, subtler way.
    const albumId = await seedFrozen(sql, 'matched-empty');

    expect(await applyStreamingFill(sql, albumId, MATCHED_EMPTY_FILL)).toBe(true);

    const row = await readStreaming(sql, albumId);
    expect(row.spotify_url).toBeNull();
    expect(row.spotify_status).toBe('unresolved');
    expect(row.apple_music_status).toBe('unresolved');
  });

  test('a no_match asserts no streaming verdict — the status columns stay NULL', async () => {
    // Mirrors enrich.ts's linked no-match arm, which writes the three
    // synthesized URLs and deliberately touches no status column.
    const albumId = await seedFrozen(sql, 'no-match-statuses');

    expect(await applyStreamingFill(sql, albumId, SYNTH_ONLY_FILL)).toBe(true);

    const row = await readStreaming(sql, albumId);
    expect(row.spotify_status).toBeNull();
    expect(row.apple_music_status).toBeNull();
  });

  test('idempotent: a second run over an already-drained row writes nothing', async () => {
    const albumId = await seedFrozen(sql, 'idempotent');
    expect(await applyStreamingFill(sql, albumId, FULL_FILL)).toBe(true);
    expect(await applyStreamingFill(sql, albumId, FULL_FILL)).toBe(false);
  });

  test('a row with no album_metadata entry at all is not created by the drain', async () => {
    // The drain heals existing rows; minting one would be asserting a match
    // nobody made. A linked album with no album_metadata row is the enrichment
    // worker's job, not this one's.
    const albumId = await insertLibraryAlbum(sql, 'absent-row');
    insertedAlbumIds.push(albumId);

    expect(await applyStreamingFill(sql, albumId, FULL_FILL)).toBe(false);
    const rows = await sql`SELECT 1 FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${albumId}`;
    expect(rows.length).toBe(0);
  });
});
