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
  const createdAlbumIds = [];

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) {
      try {
        if (createdAlbumIds.length > 0) {
          // The library rows and their cascading dependents are already gone
          // -- every album here is deleted via the API before this spec ends.
          // Only the (permanently-retained-by-design) snapshot rows this
          // spec's deletes wrote are left to clear, same as
          // library-delete.spec.js's teardown.
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

  const createAndDeleteAlbum = async (title, artist_name) => {
    const created = await auth
      .post('/library')
      .send({ album_title: title, artist_name, label: `BS#2561 Archive Test ${uniq}`, genre_id: GEN, format_id: FMT })
      .expect(201);
    createdAlbumIds.push(created.body.id);
    await auth.delete(`/library/${created.body.id}`).expect(204);
    return created.body;
  };

  test('lists a real delete as a batch, with the deleted row, its children, the actor, and the unrecoverable-dependents note', async () => {
    const title = `${marker} Solo`;
    const album = await createAndDeleteAlbum(title, 'BS#2561 Archive Artist');

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
    // Every one of the eight children captureCatalogDeleteSnapshot declares
    // for a library delete is a KEY in `children`, even when this album had
    // no rows in that table -- an absent key vs. an empty array is exactly
    // the ambiguity `captureCatalogDeleteSnapshot`'s own unit suite pins.
    expect(Object.keys(entity.children).sort()).toEqual(
      [
        'album_critic_reviews',
        'artist_library_crossreference',
        'bins',
        'compilation_track_artist',
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
  });

  test('does not read album_review_submissions -- the row is neither captured nor implied recoverable beyond the unrecoverable note', async () => {
    const title = `${marker} Reviewed`;
    const album = await createAndDeleteAlbum(title, 'BS#2561 Archive Artist');
    const sourceKey = `bs2561:${uniq}`;
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_review_submissions
         (source_key, album_id, artist_name, album_title, review, reviewer_raw)
       VALUES ($1, $2, 'BS#2561 Archive Artist', $3, 'a real review', 'Real Name')`,
      [sourceKey, album.id, title]
    );

    const res = await auth.get('/library/deleted').query({ search: title }).expect(200);
    const [batch] = res.body.results;

    expect(batch.entities.some((entity) => entity.table === 'album_review_submissions')).toBe(false);
    expect(JSON.stringify(batch)).not.toContain('Real Name');

    await sql.unsafe(`DELETE FROM "${SCHEMA}".album_review_submissions WHERE source_key = $1`, [sourceKey]);
  });

  test('pages newest batch first, and search scopes both the page and the total', async () => {
    const pagingMarker = `${marker} Page`;
    const first = await createAndDeleteAlbum(`${pagingMarker} First`, 'BS#2561 Archive Artist');
    const second = await createAndDeleteAlbum(`${pagingMarker} Second`, 'BS#2561 Archive Artist');

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
    await createAndDeleteAlbum(`${marker} Findable`, `Findable Artist ${uniq}`);

    const byTitle = await auth
      .get('/library/deleted')
      .query({ search: `${marker} Findable` })
      .expect(200);
    expect(byTitle.body.results.length).toBeGreaterThanOrEqual(1);

    const byArtist = await auth
      .get('/library/deleted')
      .query({ search: `Findable Artist ${uniq}` })
      .expect(200);
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
