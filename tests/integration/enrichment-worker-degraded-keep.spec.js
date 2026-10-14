/**
 * Integration test for the degraded re-ask keep-stored rule (BS#3117) in
 * `apps/enrichment-worker/enrich.ts#upsertMatchedAlbumMetadata`.
 *
 * When LML's Discogs breaker sheds part of the enrichment tail, the reply is
 * still a match but carries null for the release-scoped fields (release-step
 * shed, or `_build_degraded_response`) or the artist-scoped fields
 * (artist-step shed, LML#1420), with `degraded: true`. On such a reply the
 * conflict branch keeps each stored value the reply leaves null, but only
 * while the reply names the same release (`discogs_url`) or artist
 * (`discogs_artist_id`) as the row, or names none. A reply that bound a
 * different release or artist is written as-is, so the row never mixes two.
 *
 * Runs the REAL `buildDegradedConflictSet` from its compiled
 * `apps/enrichment-worker/dist/degraded-keep-sql.cjs` inside a real
 * `INSERT ... ON CONFLICT DO UPDATE` (the `excluded` pseudo-table only exists
 * there), the same recipe as `enrichment-worker-streaming-toctou.spec.js`
 * (BS#1945): no hand-mirrored SQL to drift. Only the columns the rule covers
 * are written, which is enough because each `SET` expression reads the
 * pre-statement row independently.
 *
 * Needs a built `@wxyc/database` and `@wxyc/enrichment-worker`; CI's Build step
 * (`npm run build`) produces both before the integration tier runs.
 *
 * @see WXYC/Backend-Service#3117
 * @see WXYC/library-metadata-lookup#1420
 */

// See enrichment-worker-streaming-toctou.spec.js: opt back into the real
// drizzle-orm, which the repo-wide unit mock would otherwise replace.
jest.unmock('drizzle-orm');

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');
const { db, album_metadata, closeDatabaseConnection } = require('@wxyc/database');
const { sql } = require('drizzle-orm');

const repoRoot = path.join(__dirname, '..', '..');
const DIST = path.join(repoRoot, 'apps', 'enrichment-worker', 'dist', 'degraded-keep-sql.cjs');
const SRC = path.join(repoRoot, 'apps', 'enrichment-worker', 'degraded-keep-sql.ts');
// Throws rather than skips, so a stale build cannot pass against old SQL.
if (!fs.existsSync(DIST) || fs.statSync(DIST).mtimeMs < fs.statSync(SRC).mtimeMs) {
  throw new Error(
    'apps/enrichment-worker/dist/degraded-keep-sql.cjs is missing or older than its source. Rebuild:\n' +
      '  npm run build --workspace=@wxyc/database --workspace=@wxyc/enrichment-worker'
  );
}
const { buildDegradedConflictSet } = require(DIST);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const STORED = {
  artwork_url: 'https://i.discogs.com/stored/cover.jpg',
  discogs_url: 'https://discogs.com/release/111',
  release_year: 2008,
  label: 'Domino',
  full_release_date: '2008-03-11',
  genres: ['Rock'],
  styles: ['Folk'],
  tracklist: [{ position: '1', title: 'la paradoja' }],
  discogs_artist_id: 3840,
  artist_bio: 'A stored bio.',
  artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina',
  bio_tokens: [{ type: 'plainText', text: 'Argentine musician' }],
  artist_image_url: 'https://i.discogs.com/stored/artist.jpg',
};

const NULL_RELEASE_FIELDS = {
  release_year: null,
  label: null,
  full_release_date: null,
  genres: null,
  styles: null,
  tracklist: null,
};
const NULL_ARTIST_FIELDS = {
  artist_bio: null,
  artist_wikipedia_url: null,
  bio_tokens: null,
  artist_image_url: null,
};

/** The conflict branch of a degraded re-ask, narrowed to the rule's columns. */
async function degradedReask(albumId, incoming) {
  await db
    .insert(album_metadata)
    .values({ album_id: albumId, ...incoming, updated_at: sql`NOW()` })
    .onConflictDoUpdate({
      target: album_metadata.album_id,
      set: { ...incoming, ...buildDegradedConflictSet(), updated_at: sql`NOW()` },
    });
}

describe('BS#3117 degraded re-ask keep-stored rule (real PG, real builder)', () => {
  let pg;
  const insertedAlbumIds = [];

  beforeAll(() => {
    pg = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      await pg`DELETE FROM ${pg(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await pg`DELETE FROM ${pg(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
    await closeDatabaseConnection();
  });

  async function seedStoredAlbum(suffix) {
    const [{ id }] = await pg`
      INSERT INTO ${pg(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (1, 11, 1, ${'bs3117-degraded-keep-' + suffix}, 9999, 'Juana Molina')
      RETURNING id
    `;
    insertedAlbumIds.push(id);
    await db.insert(album_metadata).values({ album_id: id, ...STORED });
    return id;
  }

  async function readRow(albumId) {
    const [row] = await pg`SELECT * FROM ${pg(SCHEMA)}.album_metadata WHERE album_id = ${albumId}`;
    return row;
  }

  const expectStoredRelease = (row) => {
    for (const col of ['release_year', 'label', 'full_release_date', 'genres', 'styles', 'tracklist']) {
      expect(row[col]).toEqual(STORED[col]);
    }
  };
  const expectStoredArtist = (row) => {
    for (const col of ['artist_bio', 'artist_wikipedia_url', 'bio_tokens', 'artist_image_url']) {
      expect(row[col]).toEqual(STORED[col]);
    }
  };
  const expectNull = (row, fields) => {
    for (const col of Object.keys(fields)) expect(row[col]).toBeNull();
  };

  test.each([
    ['same artist id', STORED.discogs_artist_id],
    ['null artist id', null],
  ])('artist-step shed with the %s keeps the stored artist fields', async (_label, incomingArtistId) => {
    const albumId = await seedStoredAlbum(`artist-${incomingArtistId}`);

    await degradedReask(albumId, {
      artwork_url: STORED.artwork_url,
      discogs_url: STORED.discogs_url,
      discogs_artist_id: incomingArtistId,
      ...NULL_ARTIST_FIELDS,
    });

    const row = await readRow(albumId);
    expectStoredArtist(row);
    expect(row.discogs_artist_id).toBe(STORED.discogs_artist_id);
  });

  test('a degraded reply that bound a different artist is written as-is (no mixed-artist row)', async () => {
    const albumId = await seedStoredAlbum('artist-changed');

    await degradedReask(albumId, {
      artwork_url: STORED.artwork_url,
      discogs_url: STORED.discogs_url,
      discogs_artist_id: 99999,
      ...NULL_ARTIST_FIELDS,
    });

    const row = await readRow(albumId);
    expect(row.discogs_artist_id).toBe(99999);
    expectNull(row, NULL_ARTIST_FIELDS);
  });

  test.each([
    ['same release URL', STORED.discogs_url],
    ['null release URL', null],
  ])('release-step shed with the %s keeps the stored release fields and artwork', async (_label, incomingUrl) => {
    const albumId = await seedStoredAlbum(`release-${incomingUrl === null ? 'null' : 'same'}`);

    await degradedReask(albumId, {
      artwork_url: null,
      discogs_url: incomingUrl,
      discogs_artist_id: null,
      ...NULL_RELEASE_FIELDS,
      ...NULL_ARTIST_FIELDS,
    });

    const row = await readRow(albumId);
    expectStoredRelease(row);
    expect(row.artwork_url).toBe(STORED.artwork_url);
    expect(row.discogs_url).toBe(STORED.discogs_url);
    // Null artist id: the artist fields are kept too.
    expectStoredArtist(row);
  });

  test('a degraded reply that bound a different release is written as-is (no mixed-release row)', async () => {
    const albumId = await seedStoredAlbum('release-changed');

    await degradedReask(albumId, {
      artwork_url: 'https://i.discogs.com/other/cover.jpg',
      discogs_url: 'https://discogs.com/release/222',
      discogs_artist_id: STORED.discogs_artist_id,
      ...NULL_RELEASE_FIELDS,
      ...NULL_ARTIST_FIELDS,
    });

    const row = await readRow(albumId);
    expect(row.discogs_url).toBe('https://discogs.com/release/222');
    expect(row.artwork_url).toBe('https://i.discogs.com/other/cover.jpg');
    expectNull(row, NULL_RELEASE_FIELDS);
    // Same artist id: the artist fields are still kept.
    expectStoredArtist(row);
  });

  test('a degraded reply that carries a value still overwrites the stored one', async () => {
    const albumId = await seedStoredAlbum('nonnull');

    await degradedReask(albumId, {
      artwork_url: STORED.artwork_url,
      discogs_url: STORED.discogs_url,
      discogs_artist_id: STORED.discogs_artist_id,
      ...NULL_RELEASE_FIELDS,
      release_year: 2009,
      ...NULL_ARTIST_FIELDS,
      artist_bio: 'A newer bio.',
    });

    const row = await readRow(albumId);
    expect(row.release_year).toBe(2009);
    expect(row.label).toBe(STORED.label);
    expect(row.artist_bio).toBe('A newer bio.');
    expect(row.artist_wikipedia_url).toBe(STORED.artist_wikipedia_url);
  });
});
