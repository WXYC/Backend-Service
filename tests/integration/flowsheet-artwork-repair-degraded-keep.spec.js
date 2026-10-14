/**
 * Integration test for the degraded-reply keep-stored rule (BS#3127) in
 * `jobs/flowsheet-artwork-repair` (`repair.ts#repairLinkedAlbum` and `repairFreeFormRow`).
 *
 * When LML's Discogs breaker sheds part of the enrichment tail, the reply is
 * still a match but carries null for what the shed step would have produced,
 * with `degraded: true` (LML#1420). On such a reply the conflict branch keeps
 * each stored value the reply leaves null, but only while the reply names the
 * same release (`discogs_url`), and for the artist-scoped columns the same
 * artist (both `discogs_artist_id`s known and equal, or either unknown and the
 * release unchanged). A reply for a different release or artist is written as
 * it is. A healthy reply is written as before.
 *
 * Runs the REAL `buildDegradedConflictSet` from its compiled
 * `jobs/flowsheet-artwork-repair/dist/degraded-keep-sql.cjs` inside a real
 * `INSERT ... ON CONFLICT DO UPDATE`, the recipe of
 * `enrichment-worker-degraded-keep.spec.js` (BS#3117) and
 * `artist-unicode-dedup-merge.spec.js`: no hand-mirrored SQL to drift. Only
 * the columns the rule covers are written, which is enough because each `SET`
 * expression reads the pre-statement row independently.
 *
 * The job never writes `discogs_artist_id`, so its real incoming id is always
 * null. The "shared rule" cases pass one only to cover the artist arm the
 * builder shares with the enrichment worker.
 *
 * Needs a built `@wxyc/database` and `@wxyc/flowsheet-artwork-repair`; CI's Build step
 * (`npm run build`) produces both before the integration tier runs.
 */

// The repo-wide unit mock of drizzle-orm applies here too; the compiled
// builder needs the real one.
jest.unmock('drizzle-orm');

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');
const { db, album_metadata, flowsheet, closeDatabaseConnection } = require('@wxyc/database');
const { eq, sql } = require('drizzle-orm');

const repoRoot = path.join(__dirname, '..', '..');
const DIST = path.join(repoRoot, 'jobs', 'flowsheet-artwork-repair', 'dist', 'degraded-keep-sql.cjs');
const SRC = path.join(repoRoot, 'jobs', 'flowsheet-artwork-repair', 'degraded-keep-sql.ts');
// Throws rather than skips, so a stale build cannot pass against old SQL.
if (!fs.existsSync(DIST) || fs.statSync(DIST).mtimeMs < fs.statSync(SRC).mtimeMs) {
  throw new Error(
    'jobs/flowsheet-artwork-repair/dist/degraded-keep-sql.cjs is missing or older than its source. Rebuild:\n' +
      '  npm run build --workspace=@wxyc/database --workspace=@wxyc/flowsheet-artwork-repair'
  );
}
const builders = require(DIST);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const RELEASE = 'https://www.discogs.com/release/3127';
const OTHER_RELEASE = 'https://www.discogs.com/release/9999';

const STORED = {
  discogs_url: RELEASE,
  artwork_url: 'https://i.discogs.com/bs3127/stored.jpg',
  release_year: 2008,
  artist_bio: 'A stored bio.',
  artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina',
  discogs_artist_id: 3127,
};
const NEW_ARTWORK = 'https://i.discogs.com/bs3127/reask.jpg';

/** The linked conflict branch, narrowed to the rule's columns. */
async function reask(albumId, incoming, degraded) {
  await db
    .insert(album_metadata)
    .values({ album_id: albumId, ...incoming, updated_at: sql`NOW()` })
    .onConflictDoUpdate({
      target: album_metadata.album_id,
      set: { ...incoming, ...(degraded ? builders.buildDegradedConflictSet() : {}), updated_at: sql`NOW()` },
    });
}

describe('BS#3127 degraded reply keep-stored rule (real PG, real builder)', () => {
  let pg;
  const insertedAlbumIds = [];
  const insertedFlowsheetIds = [];

  beforeAll(() => {
    pg = getTestDb();
  });

  afterAll(async () => {
    if (insertedFlowsheetIds.length > 0) {
      await pg`DELETE FROM ${pg(SCHEMA)}.flowsheet WHERE id = ANY(${insertedFlowsheetIds})`;
    }
    if (insertedAlbumIds.length > 0) {
      await pg`DELETE FROM ${pg(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await pg`DELETE FROM ${pg(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
    await closeDatabaseConnection();
  });

  async function seedStoredAlbum(suffix) {
    const [{ id }] = await pg`
      INSERT INTO ${pg(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (1, 11, 1, ${'bs3127-degraded-keep-' + suffix}, 9999, 'Juana Molina')
      RETURNING id
    `;
    insertedAlbumIds.push(id);
    await pg`
      INSERT INTO ${pg(SCHEMA)}.album_metadata
        (album_id, discogs_url, artwork_url, release_year, artist_bio, artist_wikipedia_url, discogs_artist_id, updated_at)
      VALUES (${id}, ${STORED.discogs_url}, ${STORED.artwork_url}, ${STORED.release_year}, ${STORED.artist_bio},
              ${STORED.artist_wikipedia_url}, ${STORED.discogs_artist_id}, NOW() - INTERVAL '1 hour')
    `;
    return id;
  }

  async function readRow(albumId) {
    const [row] = await pg`
      SELECT discogs_url, artwork_url, release_year, artist_bio, artist_wikipedia_url
        FROM ${pg(SCHEMA)}.album_metadata WHERE album_id = ${albumId}
    `;
    return row;
  }

  // `artwork_url` is null in the reply so the release guard decides it too.
  const shedReply = (discogsUrl, extra = {}) => ({
    discogs_url: discogsUrl,
    artwork_url: null,
    release_year: null,
    artist_bio: null,
    artist_wikipedia_url: null,
    ...extra,
  });

  test.each([
    { label: 'no release url', discogsUrl: null, extra: {}, releaseKept: true, bioKept: true },
    { label: 'the same release', discogsUrl: RELEASE, extra: {}, releaseKept: true, bioKept: true },
    { label: 'a different release', discogsUrl: OTHER_RELEASE, extra: {}, releaseKept: false, bioKept: false },
    {
      label: 'shared rule: the same artist id on a different release',
      discogsUrl: OTHER_RELEASE,
      extra: { discogs_artist_id: 3127 },
      releaseKept: false,
      bioKept: true,
    },
    {
      label: 'shared rule: a different artist id on the same release',
      discogsUrl: RELEASE,
      extra: { discogs_artist_id: 9999 },
      releaseKept: true,
      bioKept: false,
    },
  ])('degraded reply with $label', async ({ label, discogsUrl, extra, releaseKept, bioKept }) => {
    const albumId = await seedStoredAlbum(label);

    await reask(albumId, shedReply(discogsUrl, extra), true);

    const row = await readRow(albumId);
    expect(row.discogs_url).toBe(discogsUrl ?? STORED.discogs_url);
    expect(row.artwork_url).toBe(releaseKept ? STORED.artwork_url : null);
    expect(row.release_year).toBe(releaseKept ? STORED.release_year : null);
    expect(row.artist_bio).toBe(bioKept ? STORED.artist_bio : null);
    expect(row.artist_wikipedia_url).toBe(bioKept ? STORED.artist_wikipedia_url : null);
  });

  test('a degraded reply that carries a value still overwrites the stored one', async () => {
    const albumId = await seedStoredAlbum('carries-value');

    await reask(
      albumId,
      shedReply(RELEASE, { artwork_url: NEW_ARTWORK, release_year: 2009, artist_bio: 'A newer bio.' }),
      true
    );

    const row = await readRow(albumId);
    expect(row.artwork_url).toBe(NEW_ARTWORK);
    expect(row.release_year).toBe(2009);
    expect(row.artist_bio).toBe('A newer bio.');
    expect(row.artist_wikipedia_url).toBe(STORED.artist_wikipedia_url);
  });

  test('a healthy reply with null fields still clears them (the builder is not applied)', async () => {
    const albumId = await seedStoredAlbum('healthy');

    await reask(albumId, shedReply(RELEASE, { artwork_url: NEW_ARTWORK }), false);

    const row = await readRow(albumId);
    expect(row.artwork_url).toBe(NEW_ARTWORK);
    expect(row.release_year).toBeNull();
    expect(row.artist_bio).toBeNull();
  });

  // BS#3127 review: the free-form path's inline `flowsheet` UPDATE, with the
  // real `buildDegradedInlineSet`. `flowsheet` has no `discogs_artist_id`, so
  // the bio is kept only for the same release.
  async function seedFreeFormRow(suffix) {
    const [{ id }] = await pg`
      INSERT INTO ${pg(SCHEMA)}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title, request_flag, segue,
         metadata_status, discogs_url, artwork_url, release_year, artist_bio, artist_wikipedia_url)
      VALUES
        (99999, 'track', ${'bs3127-degraded-inline-' + suffix}, 'Test Album', 'Test Track', false, false,
         'enriched_match', ${STORED.discogs_url}, NULL, ${STORED.release_year}, ${STORED.artist_bio},
         ${STORED.artist_wikipedia_url})
      RETURNING id
    `;
    insertedFlowsheetIds.push(id);
    return id;
  }

  test.each([
    { label: 'no release url', discogsUrl: null, kept: true },
    { label: 'the same release', discogsUrl: RELEASE, kept: true },
    { label: 'a different release', discogsUrl: OTHER_RELEASE, kept: false },
  ])('free-form row, degraded reply with $label', async ({ label, discogsUrl, kept }) => {
    const id = await seedFreeFormRow(label);
    const payload = { ...shedReply(discogsUrl), artwork_url: NEW_ARTWORK };

    await db
      .update(flowsheet)
      .set({ ...payload, ...builders.buildDegradedInlineSet(payload) })
      .where(eq(flowsheet.id, id));

    const [row] = await pg`
      SELECT discogs_url, artwork_url, release_year, artist_bio, artist_wikipedia_url
        FROM ${pg(SCHEMA)}.flowsheet WHERE id = ${id}
    `;
    expect(row.artwork_url).toBe(NEW_ARTWORK);
    expect(row.discogs_url).toBe(discogsUrl ?? STORED.discogs_url);
    expect(row.release_year).toBe(kept ? STORED.release_year : null);
    expect(row.artist_bio).toBe(kept ? STORED.artist_bio : null);
    expect(row.artist_wikipedia_url).toBe(kept ? STORED.artist_wikipedia_url : null);
  });
});
