/**
 * Integration tests for GET /library/deleted (BS#2561 / F2a) -- the read half
 * of the `catalog_delete_snapshot` archive `DELETE /library/:id` writes to
 * (BS#2560, covered by library-delete.spec.js).
 *
 * `catalog_delete_snapshot` is permanently retained, and this suite shares a
 * database with every other integration spec (plus its own prior runs), so
 * every assertion here scopes to `?search=` on a per-run unique marker rather
 * than asserting exact `total`/`results` counts -- the archive can and will
 * hold rows this spec did not create.
 *
 * Covers the three acceptance criteria this endpoint's controller/route unit
 * tests cannot reach without a real DB: the listing and paging against real
 * `catalog_delete_snapshot` rows written by a real delete, the substring
 * search, and that an unauthenticated request is refused (role-tier gating
 * itself is pinned by library-deleted-permissions.route.test.ts).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GEN = 11; // 'Rock'
const FMT = 1; // 'cd'

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

describe('GET /library/deleted (BS#2561)', () => {
  let auth;
  let sql;
  const uniq = Date.now();
  const marker = `BS#2561 Archive ${uniq}`;
  const artistName = `${marker} Artist`;
  const createdAlbumIds = [];
  let artistId;

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();

    // A fresh artist, not a shared fixture name -- `POST /library` resolves
    // `artist_name` via a genre-scoped exact lookup (`artistIdFromName`), so
    // a made-up name 400s ("Artist doesn't exist..."). Same recipe
    // library-update.spec.js's `beforeAll` uses: a `uniq`-suffixed name plus
    // an explicit `code_number` so this run's bucket can't collide with a
    // concurrent one.
    const artist = await auth
      .post('/library/artists')
      .send({ artist_name: artistName, code_letters: 'B9', genre_id: GEN, code_number: 9000 + (uniq % 500) })
      .expect(201);
    artistId = artist.body.id;
  });

  afterAll(async () => {
    if (sql) {
      try {
        if (createdAlbumIds.length > 0) {
          // The library rows and their cascading dependents are already gone
          // -- every album here is deleted via the API before this spec ends.
          // Only the (permanently-retained-by-design) snapshot rows this
          // spec's deletes wrote are left to clear, same as
          // library-delete.spec.js's teardown. The artist row created above
          // is left in place, matching library-update.spec.js's convention
          // of not tearing down `uniq`-suffixed fixture artists it creates.
          await sql.unsafe(
            `DELETE FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY($1::int[])`,
            [createdAlbumIds]
          );
        }
      } finally {
        await sql.end();
      }
    }
  });

  const createAndDeleteAlbum = async (title) => {
    const created = await auth
      .post('/library')
      .send({
        album_title: title,
        artist_id: artistId,
        label: `BS#2561 Archive Test ${uniq}`,
        genre_id: GEN,
        format_id: FMT,
      })
      .expect(201);
    createdAlbumIds.push(created.body.id);
    await auth.delete(`/library/${created.body.id}`).expect(204);
    return created.body;
  };

  test('lists a real delete as a batch, with the deleted row, its children, the actor, and the unrecoverable-dependents note', async () => {
    const title = `${marker} Solo`;
    const album = await createAndDeleteAlbum(title);

    const res = await auth.get('/library/deleted').query({ search: title }).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.results).toHaveLength(1);
    const [batch] = res.body.results;

    expect(typeof batch.batch_id).toBe('string');
    expect(batch.captured_at).toBeTruthy();
    // `actor.user_id` is whatever `req.auth.id`/`sub` resolved to for this
    // integration harness's token -- asserted as "recorded something",
    // not against a specific literal, since that identity is the test
    // environment's, not this endpoint's contract.
    expect(typeof batch.actor.user_id === 'string' || batch.actor.user_id === null).toBe(true);

    expect(batch.entities).toHaveLength(1);
    const [entity] = batch.entities;
    expect(entity.entity_kind).toBe('library');
    expect(entity.table).toBe('library');
    expect(entity.row.id).toBe(album.id);
    expect(entity.row.album_title).toBe(title);
    // Every one of the ten children `deleteAlbumFromDB` declares to
    // `captureCatalogDeleteSnapshot` is a KEY in `children`, even when this
    // album had no rows in that table -- an absent key vs. an empty array is
    // exactly the ambiguity `captureCatalogDeleteSnapshot`'s own unit suite
    // pins.
    expect(Object.keys(entity.children).sort()).toEqual(
      [
        'album_critic_reviews',
        'artist_library_crossreference',
        'bins',
        'compilation_track_artist',
        'digital_asset',
        'digital_asset_file',
        'library_urls',
        'reviews',
        'rotation',
        'rotation_urls',
      ].sort()
    );

    expect(batch.unrecoverable).toEqual(
      expect.arrayContaining([
        'album_metadata',
        'library_identity',
        'library_identity_source',
        'uncovered_release_search_markers',
        'album_review_submissions',
      ])
    );
    // A `library` batch has a replay plan (BS#2616) -- the restore endpoint
    // can actually bring this one back.
    expect(batch.restorable).toBe(true);
  });

  test('does not read album_review_submissions -- the row is neither captured nor implied recoverable beyond the unrecoverable note', async () => {
    const title = `${marker} Reviewed`;
    const created = await auth
      .post('/library')
      .send({
        album_title: title,
        artist_id: artistId,
        label: `BS#2561 Archive Test ${uniq}`,
        genre_id: GEN,
        format_id: FMT,
      })
      .expect(201);
    const album = created.body;
    createdAlbumIds.push(album.id);

    // Inserted BEFORE the delete, like library-delete.spec.js's own snapshot
    // probe -- a row created AFTER the delete would prove nothing about what
    // the snapshot captured. `reviewer_raw` carries a distinctive value so
    // the assertion below can prove the PII never reaches the response.
    const sourceKey = `bs2561:${uniq}`;
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_review_submissions (source, source_key, norm_artist, norm_album, album_id, reviewer_raw)
       VALUES ('google_form', $1, $2, $3, $4, 'BS2561-PII-PROBE-REVIEWER')`,
      [sourceKey, artistName.toLowerCase(), title, album.id]
    );

    await auth.delete(`/library/${album.id}`).expect(204);

    const res = await auth.get('/library/deleted').query({ search: title }).expect(200);
    const [batch] = res.body.results;

    expect(batch.entities.some((entity) => entity.table === 'album_review_submissions')).toBe(false);
    expect(JSON.stringify(batch)).not.toContain('BS2561-PII-PROBE-REVIEWER');

    await sql.unsafe(`DELETE FROM "${SCHEMA}".album_review_submissions WHERE source_key = $1`, [sourceKey]);
  });

  test('pages newest batch first, and search scopes both the page and the total', async () => {
    const pagingMarker = `${marker} Page`;
    const first = await createAndDeleteAlbum(`${pagingMarker} First`);
    const second = await createAndDeleteAlbum(`${pagingMarker} Second`);

    const page0 = await auth.get('/library/deleted').query({ search: pagingMarker, limit: 1, page: 0 }).expect(200);
    const page1 = await auth.get('/library/deleted').query({ search: pagingMarker, limit: 1, page: 1 }).expect(200);
    expect(page0.body.results).toHaveLength(1);
    expect(page1.body.results).toHaveLength(1);
    expect(page0.body.total).toBe(2);
    expect(page0.body.totalPages).toBe(2);
    // Newest (`second`) on page 0, older (`first`) on page 1 -- a page
    // boundary can never split one batch's rows across two pages, but
    // ordering ACROSS batches is what this asserts.
    expect(page0.body.results[0].entities[0].row.id).toBe(second.id);
    expect(page1.body.results[0].entities[0].row.id).toBe(first.id);
  });

  test('search is a name-field substring match, not field-scoped', async () => {
    await createAndDeleteAlbum(`${marker} Findable`);

    const byTitle = await auth
      .get('/library/deleted')
      .query({ search: `${marker} Findable` })
      .expect(200);
    expect(byTitle.body.results.length).toBeGreaterThanOrEqual(1);

    // `artistName` isn't in any album_title this spec creates, so a match
    // here can only have come through the entity row's `artist_name` field.
    const byArtist = await auth.get('/library/deleted').query({ search: artistName }).expect(200);
    expect(byArtist.body.results.length).toBeGreaterThanOrEqual(1);

    const noMatch = await auth
      .get('/library/deleted')
      .query({ search: `nonexistent-marker-${uniq}` })
      .expect(200);
    expect(noMatch.body).toEqual({ results: [], total: 0, page: 0, totalPages: 0 });
  });

  test('rejects an invalid limit with a 400', async () => {
    await auth.get('/library/deleted').query({ limit: '0' }).expect(400);
  });

  test('a request with no Authorization header is rejected', async () => {
    await request.get('/library/deleted').expect(401);
  });
});
