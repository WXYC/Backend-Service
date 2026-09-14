const { randomInt } = require('node:crypto');
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

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 4 characters — `artists.code_letters` is varchar(4), so anything longer
 * 22001s at the INSERT — and RANDOM, not time-derived like the older specs'
 * `Date.now().toString(36).slice(-n)`: leftover artist rows from prior runs
 * against a persistent DB are never deleted, and a 4-char time suffix wraps
 * every ~28 minutes (36^4 ms), so a clock-derived value eventually collides
 * with a previous run's row and turns the happy path into a spurious
 * `artist_code_conflict`. 36^4 random buckets against a handful of leftover
 * rows per run keeps that practically impossible.
 */
function uniqueSuffix() {
  return Array.from({ length: 4 }, () => BASE36[randomInt(BASE36.length)]).join('');
}

async function countLabels(labelName) {
  const sql = getTestDb();
  const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.labels WHERE label_name = ${labelName}`;
  return rows.length;
}

/**
 * Exact-title library probe for the rollback assertions. NOT
 * `GET /library?album_title=` — that search is fuzzy, so once this suite's
 * earlier tests really insert releases all titled `Filing … Album …`, a probe
 * for the rejected request's title matches the sibling rows and the
 * nothing-persisted assertion can never hold.
 */
async function countLibraryRows(albumTitle) {
  const sql = getTestDb();
  const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.library WHERE album_title = ${albumTitle}`;
  return rows.length;
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
    expect(res.body.artist.genre_id).toBe(11);
    expect(res.body.artist.code_artist_number).toBe(1);

    // No second artist row was minted for the same code triple.
    const byCode = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: 11, code_letters: suffix, code_number: 1 })
      .expect(200);
    expect(byCode.body.artists).toHaveLength(1);
  });

  // The contract (`wxyc-shared/api.yaml` `/library/filings`) assigns a
  // dangling `artist.artist_id` to 400 and declares no 404 on this route.
  test('existing-artist arm 400s cleanly on a bogus artist_id', async () => {
    const suffix = uniqueSuffix();
    const res = await auth
      .post('/library/filings')
      .send({
        artist: { kind: 'existing', artist_id: 999999999 },
        release: { album_title: `Filing Bogus Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(400);

    expectErrorContains(res, 'does not reference an existing artist');
  });

  test('existing-artist arm 400s when the artist has no code in release.genre_id', async () => {
    const suffix = uniqueSuffix();
    // Filed in genre 6 only; the filing below targets genre 11, where this
    // artist has no crossreference — accepting it would write a release whose
    // genre holds no artist code to shelve it under.
    const otherGenreArtist = await auth
      .post('/library/artists')
      .send({ artist_name: `Filing WrongGenre ${suffix}`, code_letters: suffix, genre_id: 6, code_number: 1 })
      .expect(201);

    const res = await auth
      .post('/library/filings')
      .send({
        artist: { kind: 'existing', artist_id: otherGenreArtist.body.id },
        release: { album_title: `Filing WrongGenre Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(400);

    expectErrorContains(res, 'no artist code in release.genre_id');
  });

  test('create arm 400s when artist.genre_id and release.genre_id diverge', async () => {
    const suffix = uniqueSuffix();
    const res = await auth
      .post('/library/filings')
      .send({
        artist: {
          kind: 'create',
          artist_name: `Filing GenreSplit ${suffix}`,
          code_letters: suffix,
          genre_id: 6,
          code_number: 1,
        },
        release: { album_title: `Filing GenreSplit Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(400);

    expectErrorContains(res, 'artist.genre_id must equal release.genre_id');
  });

  test('create arm 400s an over-length code_letters instead of 500ing at the varchar(4) column', async () => {
    const suffix = uniqueSuffix();
    const res = await auth
      .post('/library/filings')
      .send({
        artist: {
          kind: 'create',
          artist_name: `Filing LongCode ${suffix}`,
          code_letters: `${suffix}X`,
          genre_id: 11,
          code_number: 1,
        },
        release: { album_title: `Filing LongCode Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(400);

    expectErrorContains(res, 'code_letters must be 4 characters or fewer');
  });

  test('artist_code_conflict: propagates the named reason with the contract Artist shape and persists nothing', async () => {
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

    // `artist` is the full contract `Artist` (id/artist_name/code_letters/
    // code_artist_number/genre_id) — the shape `LibraryFilingConflictError`
    // $refs and the strictly-typed generated clients require to decode the
    // 409 at all.
    expect(res.body).toEqual({
      message: 'Artist code already exists for that genre and code letters.',
      reason: 'artist_code_conflict',
      artist: {
        id: first.body.id,
        artist_name: `Filing CodeDup A ${suffix}`,
        code_letters: suffix,
        code_artist_number: 1,
        genre_id: 11,
      },
    });

    // No release was inserted under the rejected request.
    expect(await countLibraryRows(albumTitle)).toBe(0);
  });

  test('artist_name_conflict: propagates the named reason with the contract Artist shape', async () => {
    const codeA = uniqueSuffix();
    let codeB = uniqueSuffix();
    while (codeB === codeA) codeB = uniqueSuffix();
    const artistName = `Filing NameDup ${codeA}`;
    const first = await auth
      .post('/library/artists')
      .send({ artist_name: artistName, code_letters: codeA, genre_id: 11, code_number: 1 })
      .expect(201);

    const res = await auth
      .post('/library/filings')
      .send({
        artist: { kind: 'create', artist_name: artistName, code_letters: codeB, genre_id: 11, code_number: 1 },
        release: { album_title: `Filing NameDup Album ${codeA}`, label: 'Test Label', genre_id: 11, format_id: 1 },
      })
      .expect(409);

    expect(res.body.reason).toBe('artist_name_conflict');
    expect(res.body.artist).toEqual({
      id: first.body.id,
      artist_name: artistName,
      code_letters: codeA,
      code_artist_number: 1,
      genre_id: 11,
    });
  });

  test('rotation card that does not exist draws the declared 400, not an undeclared 404', async () => {
    const suffix = uniqueSuffix();
    const res = await auth
      .post('/library/filings')
      .send({
        artist: {
          kind: 'create',
          artist_name: `Filing NoCard ${suffix}`,
          code_letters: suffix,
          genre_id: 11,
          code_number: 1,
        },
        release: { album_title: `Filing NoCard Album ${suffix}`, label: 'Test Label', genre_id: 11, format_id: 1 },
        rotation: { rotation_bin: 'S', card_id: 999999999 },
      })
      .expect(400);

    expectErrorContains(res, 'Rotation card not found');

    // All-or-nothing: the dangling card reference rolled back the artist.
    const byCode = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: 11, code_letters: suffix, code_number: 1 })
      .expect(404);
    expect(byCode.body.reason).toBe('code_not_assigned');
  });

  test('rotation_card_bin_mismatch: propagates the named reason and leaves no artist, release, or label row', async () => {
    const suffix = uniqueSuffix();
    const cardOtherBin = await auth
      .post('/library/rotation/cards')
      .send({ bin: 'H', name: `Filing Card ${suffix}` })
      .expect(200);
    createdCardIds.push(cardOtherBin.body.id);

    const albumTitle = `Filing Mismatch Album ${suffix}`;
    // A label name nothing else uses, so the assertion below proves the
    // create-or-reuse label upsert ran inside the SAME transaction: with the
    // shared 'Test Label' the upsert takes its reuse branch and writes
    // nothing, and the rollback would have nothing to prove.
    const labelName = `Filing Mismatch Label ${suffix}`;
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
        release: { album_title: albumTitle, label: labelName, genre_id: 11, format_id: 1 },
        rotation: { rotation_bin: 'S', card_id: cardOtherBin.body.id },
      })
      .expect(409);

    expect(res.body.reason).toBe('rotation_card_bin_mismatch');

    // All-or-nothing: the rotation-stage rejection rolled back the artist,
    // release, AND the labels row minted from the fresh label text this same
    // request had already written.
    const byCode = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: 11, code_letters: suffix, code_number: 1 })
      .expect(404);
    expect(byCode.body.reason).toBe('code_not_assigned');

    expect(await countLibraryRows(albumTitle)).toBe(0);

    expect(await countLabels(labelName)).toBe(0);
  });

  test('release-stage failure leaves no artist or label row (all-or-nothing)', async () => {
    const suffix = uniqueSuffix();
    const labelName = `Filing ReleaseFail Label ${suffix}`;

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
          label: labelName,
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

    expect(await countLabels(labelName)).toBe(0);
  });
});
