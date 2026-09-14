const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains, expectFields } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * `POST /library/filings` integration tests (BS#2474).
 *
 * Rows the create arm mints are left behind, matching `POST /library/artists`
 * and `POST /library` convention elsewhere in this suite — unique per-run
 * suffixes keep them from colliding, and nothing reads the full table. Rows a
 * rotation arm mints ARE torn down (`deleteRotationRows`, the BS#2109
 * rationale carried from `library.spec.js`): `PATCH /library/rotation` only
 * stamps `kill_date`, so a "cleaned up" row would survive and pollute the
 * uncatalogued-backlog / active-rotation reads other tests assert against.
 */
async function deleteRotationRows(rotationIds) {
  const ids = rotationIds.filter((id) => typeof id === 'number');
  if (ids.length === 0) return;
  const sql = getTestDb();
  await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id IN ${sql(ids)}`;
}

function uniqueSuffix() {
  return Date.now().toString(36).toUpperCase().slice(-6);
}

describe('POST /library/filings', () => {
  let auth;
  const createdRotationIds = [];
  const createdCardIds = [];

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  afterEach(async () => {
    await deleteRotationRows(createdRotationIds);
    createdRotationIds.length = 0;
    if (createdCardIds.length) {
      const sql = getTestDb();
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation_cards WHERE id IN ${sql(createdCardIds)}`;
      createdCardIds.length = 0;
    }
  });

  test('happy path: creates artist, release, and rotation entry in one request', async () => {
    const suffix = uniqueSuffix();
    const res = await auth
      .post('/library/filings')
      .send({
        artist: {
          kind: 'create',
          artist_name: `Filing Artist ${suffix}`,
          code_letters: suffix,
          genre_id: 11,
          code_number: 1,
        },
        release: { album_title: `Filing Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
        rotation: { rotation_bin: 'S' },
      })
      .expect(200);

    expectFields(res.body, 'artist', 'release', 'rotation');
    expectFields(res.body.artist, 'id', 'artist_name', 'code_letters', 'code_artist_number', 'genre_id');
    expect(res.body.artist.artist_name).toBe(`Filing Artist ${suffix}`);
    expect(res.body.artist.code_artist_number).toBe(1);
    expectFields(res.body.release, 'id', 'artist_id', 'album_title');
    expect(res.body.release.artist_id).toBe(res.body.artist.id);
    expectFields(res.body.rotation, 'id', 'album_id', 'rotation_bin');
    expect(res.body.rotation.album_id).toBe(res.body.release.id);
    createdRotationIds.push(res.body.rotation.id);

    const artistCard = await auth.get(`/library/artists/${res.body.artist.id}`).expect(200);
    expect(artistCard.body.artist_name).toBe(`Filing Artist ${suffix}`);
  });

  test('omits rotation from the response when the request carries none', async () => {
    const suffix = uniqueSuffix();
    const res = await auth
      .post('/library/filings')
      .send({
        artist: {
          kind: 'create',
          artist_name: `Filing NoRot ${suffix}`,
          code_letters: suffix,
          genre_id: 11,
          code_number: 1,
        },
        release: { album_title: `Filing NoRot Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(200);

    expect(res.body.rotation).toBeUndefined();
  });

  test('existing-artist arm skips creation and reuses the referenced artist', async () => {
    const suffix = uniqueSuffix();
    const existingArtist = await auth
      .post('/library/artists')
      .send({ artist_name: `Filing Existing ${suffix}`, code_letters: suffix, genre_id: 11, code_number: 1 })
      .expect(201);

    const res = await auth
      .post('/library/filings')
      .send({
        artist: { kind: 'existing', artist_id: existingArtist.body.id },
        release: { album_title: `Filing Existing Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(200);

    expect(res.body.artist.id).toBe(existingArtist.body.id);
    expect(res.body.artist.artist_name).toBe(`Filing Existing ${suffix}`);

    // No second artist row was minted for the same code triple.
    const byCode = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: 11, code_letters: suffix, code_number: 1 })
      .expect(200);
    expect(byCode.body.artists).toHaveLength(1);
  });

  test('existing-artist arm 404s cleanly on a bogus artist_id', async () => {
    const suffix = uniqueSuffix();
    const res = await auth
      .post('/library/filings')
      .send({
        artist: { kind: 'existing', artist_id: 999999999 },
        release: { album_title: `Filing Bogus Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(404);

    expectErrorContains(res, 'does not reference an existing artist');
  });

  test('artist_code_conflict: propagates the named reason and persists nothing', async () => {
    const suffix = uniqueSuffix();
    const first = await auth
      .post('/library/artists')
      .send({ artist_name: `Filing CodeDup A ${suffix}`, code_letters: suffix, genre_id: 11, code_number: 1 })
      .expect(201);

    const albumTitle = `Filing CodeDup Album ${suffix}`;
    const res = await auth
      .post('/library/filings')
      .send({
        artist: {
          kind: 'create',
          artist_name: `Filing CodeDup B ${suffix}`,
          code_letters: suffix,
          genre_id: 11,
          code_number: 1,
        },
        release: { album_title: albumTitle, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(409);

    expect(res.body).toEqual({
      message: 'Artist code already exists for that genre and code letters.',
      reason: 'artist_code_conflict',
      artist: { artist_id: first.body.id, artist_name: `Filing CodeDup A ${suffix}`, code_letters: suffix },
    });

    // No release was inserted under the rejected request.
    const search = await auth.get('/library').query({ album_title: albumTitle }).expect(200);
    expect(search.body).toHaveLength(0);
  });

  test('artist_name_conflict: propagates the named reason', async () => {
    const suffix = uniqueSuffix();
    const artistName = `Filing NameDup ${suffix}`;
    await auth
      .post('/library/artists')
      .send({ artist_name: artistName, code_letters: `${suffix}A`, genre_id: 11, code_number: 1 })
      .expect(201);

    const res = await auth
      .post('/library/filings')
      .send({
        artist: { kind: 'create', artist_name: artistName, code_letters: `${suffix}B`, genre_id: 11, code_number: 1 },
        release: { album_title: `Filing NameDup Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(409);

    expect(res.body.reason).toBe('artist_name_conflict');
  });

  test('rotation_card_bin_mismatch: propagates the named reason and leaves no artist or release row', async () => {
    const suffix = uniqueSuffix();
    const cardOtherBin = await auth
      .post('/library/rotation/cards')
      .send({ bin: 'H', name: `Filing Card ${suffix}` })
      .expect(200);
    createdCardIds.push(cardOtherBin.body.id);

    const albumTitle = `Filing Mismatch Album ${suffix}`;
    const res = await auth
      .post('/library/filings')
      .send({
        artist: {
          kind: 'create',
          artist_name: `Filing Mismatch ${suffix}`,
          code_letters: suffix,
          genre_id: 11,
          code_number: 1,
        },
        release: { album_title: albumTitle, label: 'Test Label', genre_id: 11, format_id: 1 },
        rotation: { rotation_bin: 'S', card_id: cardOtherBin.body.id },
      })
      .expect(409);

    expect(res.body.reason).toBe('rotation_card_bin_mismatch');

    // All-or-nothing: the rotation-stage rejection rolled back the artist and
    // release this same request had already written.
    const byCode = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: 11, code_letters: suffix, code_number: 1 })
      .expect(404);
    expect(byCode.body.reason).toBe('code_not_assigned');

    const search = await auth.get('/library').query({ album_title: albumTitle }).expect(200);
    expect(search.body).toHaveLength(0);
  });

  test('release-stage failure leaves no artist row (all-or-nothing)', async () => {
    const suffix = uniqueSuffix();

    await auth
      .post('/library/filings')
      .send({
        artist: {
          kind: 'create',
          artist_name: `Filing ReleaseFail ${suffix}`,
          code_letters: suffix,
          genre_id: 11,
          code_number: 1,
        },
        // A dangling format_id trips the FK constraint on the release insert,
        // never validated ahead of time (matches POST /library's own
        // addAlbum, which doesn't pre-check format_id either) — the write
        // fails deep inside the same transaction the artist insert ran in.
        release: {
          album_title: `Filing ReleaseFail Album ${suffix}`,
          label: 'Test Label',
          genre_id: 11,
          format_id: 999999999,
        },
      })
      .expect(500);

    const byCode = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: 11, code_letters: suffix, code_number: 1 })
      .expect(404);
    expect(byCode.body.reason).toBe('code_not_assigned');
  });
});
