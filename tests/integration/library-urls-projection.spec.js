const { randomInt } = require('node:crypto');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * BS#2492 (definitive-release-links epic): the catalog READ projections carry a
 * release's definitive links (`library_urls`), RELEASE-SCOPED and
 * UNCONDITIONAL — a plain `library_id` correlated subquery with NO
 * CURRENT_DATE/rotation predicate. That is the deliberate difference from
 * `card`/`rotation_bin`, which ride the CURRENT_DATE-filtered rotation JOIN: a
 * release's links persist and show whether or not it is currently rotating.
 *
 * These exercise the real SQL end to end (supertest + PG), which the unit
 * mapper tests can't: the write goes through the storage path
 * (`PUT /library/:id/urls`, BS#2491), and the reads come back through both the
 * album-detail read (`GET /library/info`, `getAlbumFromDB`) and the catalog
 * search projection (`GET /library/query`, `AlbumSearchResultRow`).
 *
 * The seeded release (library.id=7100, Autechre / Confield) comes from
 * tests/fixtures/shape.sql — a plain catalog row with no rotation, so it also
 * pins the persist behavior. We write links to it, then delete only those
 * links in afterAll (other specs rely on 7100 existing; nothing reads its
 * links). Created releases are left behind per this suite's convention.
 */

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function uniqueSuffix() {
  return Array.from({ length: 4 }, () => BASE36[randomInt(BASE36.length)]).join('');
}

const SEEDED_ID = 7100;
// Position order is load-bearing: the projection's `array_agg(... ORDER BY
// position)` must return them in exactly this order.
const URLS = [
  'https://autechre.bandcamp.com/album/confield',
  'https://open.spotify.com/album/1a2b3c',
  'https://discogs.com/release/789',
];

async function createRelease(auth) {
  const suffix = uniqueSuffix();
  const res = await auth
    .post('/library/filings')
    .send({
      artist: { kind: 'create', artist_name: `Urls ${suffix}`, code_letters: suffix, genre_id: 11, code_number: 1 },
      release: { album_title: `Urls Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
    })
    .expect(200);
  return res.body.release.id;
}

describe('library_urls read projection (BS#2492)', () => {
  let auth;
  const createdLibraryIds = [];

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  afterAll(async () => {
    const sql = getTestDb();
    const ids = [SEEDED_ID, ...createdLibraryIds];
    await sql`DELETE FROM ${sql(SCHEMA)}.library_urls WHERE library_id IN ${sql(ids)}`;
  });

  test('PUT /library/:id/urls echoes the stored links in order (AlbumDetail re-read)', async () => {
    const res = await auth.put(`/library/${SEEDED_ID}/urls`).send({ urls: URLS }).expect(200);
    expect(res.body.id).toBe(SEEDED_ID);
    expect(res.body.urls).toEqual(URLS);
  });

  test('GET /library/info carries the release links, position-ordered', async () => {
    const res = await auth.get(`/library/info?album_id=${SEEDED_ID}`).expect(200);
    expect(res.body.urls).toEqual(URLS);
  });

  test('GET /library/query carries the release links on the search projection', async () => {
    const res = await auth.get('/library/query').query({ q: 'album:Confield', limit: 10 }).expect(200);
    const row = res.body.results.find((r) => r.id === SEEDED_ID);
    expect(row).toBeDefined();
    expect(row.urls).toEqual(URLS);
  });

  test('a release with no rotation still returns its links — the persist behavior', async () => {
    const albumId = await createRelease(auth);
    createdLibraryIds.push(albumId);
    await auth
      .put(`/library/${albumId}/urls`)
      .send({ urls: ['https://discogs.com/release/555'] })
      .expect(200);

    const detail = await auth.get(`/library/info?album_id=${albumId}`).expect(200);
    // No rotation was ever created for this release, so it is not rotating; the
    // link persists on the release regardless — the whole point of the epic.
    expect(detail.body.urls).toEqual(['https://discogs.com/release/555']);

    const search = await auth.get('/library/query').query({ q: 'artist:Urls', limit: 50 }).expect(200);
    const row = search.body.results.find((r) => r.id === albumId);
    expect(row).toBeDefined();
    expect(row.rotation_bin ?? null).toBeNull();
    expect(row.urls).toEqual(['https://discogs.com/release/555']);
  });

  test('a release with no links returns urls: [] on both reads', async () => {
    const albumId = await createRelease(auth);
    createdLibraryIds.push(albumId);

    const detail = await auth.get(`/library/info?album_id=${albumId}`).expect(200);
    expect(detail.body.urls).toEqual([]);
  });

  test('PUT with an empty set clears the links (replace-wholesale), and the read agrees', async () => {
    const albumId = await createRelease(auth);
    createdLibraryIds.push(albumId);
    await auth
      .put(`/library/${albumId}/urls`)
      .send({ urls: ['https://discogs.com/release/999'] })
      .expect(200);
    await auth.put(`/library/${albumId}/urls`).send({ urls: [] }).expect(200);

    const detail = await auth.get(`/library/info?album_id=${albumId}`).expect(200);
    expect(detail.body.urls).toEqual([]);
  });
});
