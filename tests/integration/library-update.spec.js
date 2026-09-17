const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains, expectFields } = require('../utils/test_helpers');

/**
 * Integration coverage for PATCH /library/:id (PR #1154 review).
 *
 * The endpoint has true partial semantics: only fields present in the body
 * are validated and written. These cases pin the review's silent-data-loss
 * scenarios — a title-typo fix must not reset disc_quantity, wipe
 * alternate_artist_name, or NULL a long-stable label_id — plus the label
 * trim/orphan paths and collision-only code_number regeneration.
 */
describe('PATCH /library/:id', () => {
  let auth;
  let album;
  const uniq = Date.now();

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    const res = await auth
      .post('/library')
      .send({
        album_title: `Patch Target ${uniq}`,
        artist_name: 'Built to Spill',
        label: `Patch Label ${uniq}`,
        genre_id: 11,
        format_id: 1,
        disc_quantity: 2,
        alternate_artist_name: 'Patch Alt Credit',
      })
      .expect(201);
    album = res.body;
    expect(album.label_id).not.toBeNull();
  });

  test('partial title edit preserves disc_quantity, alternate_artist_name, and label_id', async () => {
    const res = await auth
      .patch(`/library/${album.id}`)
      .send({ album_title: `Patch Target Renamed ${uniq}` })
      .expect(200);

    expectFields(res.body, 'id', 'album_title', 'disc_quantity', 'alternate_artist_name', 'label_id');
    expect(res.body.album_title).toBe(`Patch Target Renamed ${uniq}`);
    expect(res.body.disc_quantity).toBe(2);
    expect(res.body.alternate_artist_name).toBe('Patch Alt Credit');
    expect(res.body.label_id).toBe(album.label_id);
  });

  test('returns 400 when no updatable field is provided', async () => {
    const res = await auth.patch(`/library/${album.id}`).send({}).expect(400);
    expectErrorContains(res, 'at least one');
  });

  test('rejects empty album_title', async () => {
    const res = await auth.patch(`/library/${album.id}`).send({ album_title: '   ' }).expect(400);
    expectErrorContains(res, 'album_title');
  });

  test('rejects empty label instead of silently wiping label_id', async () => {
    const res = await auth.patch(`/library/${album.id}`).send({ label: '' }).expect(400);
    expectErrorContains(res, 'label');

    const info = await auth.get('/library/info').query({ album_id: album.id }).expect(200);
    expect(info.body.label_id).toBe(album.label_id);
  });

  test('trims label before the upsert so re-submissions hit the same labels row', async () => {
    const labelName = `Patch Trim Label ${uniq}`;
    const padded = await auth
      .patch(`/library/${album.id}`)
      .send({ label: `  ${labelName}  ` })
      .expect(200);
    expect(padded.body.label).toBe(labelName);
    expect(padded.body.label_id).not.toBeNull();

    const exact = await auth.patch(`/library/${album.id}`).send({ label: labelName }).expect(200);
    expect(exact.body.label_id).toBe(padded.body.label_id);

    const found = await auth.get('/labels/search').query({ q: labelName }).expect(200);
    const matches = found.body.filter((l) => l.label_name.trim() === labelName);
    expect(matches.length).toBe(1);
  });

  test('rejects a label_id that does not reference an existing label', async () => {
    const res = await auth.patch(`/library/${album.id}`).send({ label_id: 99999999 }).expect(400);
    expectErrorContains(res, 'label_id');
  });

  test('rejects label_id: null combined with a non-empty label', async () => {
    const res = await auth
      .patch(`/library/${album.id}`)
      .send({ label_id: null, label: 'Patch Conflicting Label' })
      .expect(400);
    expectErrorContains(res, 'label_id');
  });

  test('label_id: null clears the label linkage', async () => {
    const res = await auth.patch(`/library/${album.id}`).send({ label_id: null }).expect(200);
    expect(res.body.label_id).toBeNull();
  });

  test('validates disc_quantity type and range', async () => {
    await auth.patch(`/library/${album.id}`).send({ disc_quantity: 0 }).expect(400);
    await auth.patch(`/library/${album.id}`).send({ disc_quantity: 1.5 }).expect(400);
    await auth.patch(`/library/${album.id}`).send({ disc_quantity: 'abc' }).expect(400);
    await auth.patch(`/library/${album.id}`).send({ disc_quantity: 40000 }).expect(400);
  });

  test('returns 404 for a nonexistent album without creating an orphan label', async () => {
    const orphanLabel = `Patch Orphan Label ${uniq}`;
    await auth.patch('/library/99999999').send({ label: orphanLabel }).expect(404);

    const found = await auth.get('/labels/search').query({ q: orphanLabel }).expect(200);
    expect(found.body.length).toBe(0);
  });

  test('rejects moving the album to a genre the artist is not catalogued in', async () => {
    const res = await auth.patch(`/library/${album.id}`).send({ genre_id: 7 }).expect(400);
    expectErrorContains(res, 'not catalogued');
  });

  test('returns 404 for an unknown artist_id', async () => {
    await auth.patch(`/library/${album.id}`).send({ artist_id: 99999999 }).expect(404);
  });

  describe('artist re-attribution and code_number (review issue 7)', () => {
    let artistA;
    let artistB;
    let movingAlbum;

    beforeAll(async () => {
      // Two fresh artists so per-artist album code sequences are deterministic
      // regardless of what other suites have added to the seed artists.
      const a = await auth
        .post('/library/artists')
        .send({
          artist_name: `Patch Reattr Artist A ${uniq}`,
          code_letters: 'PA',
          genre_id: 11,
          code_number: 9000 + (uniq % 500),
        })
        .expect(201);
      artistA = a.body;

      const b = await auth
        .post('/library/artists')
        .send({
          artist_name: `Patch Reattr Artist B ${uniq}`,
          code_letters: 'PB',
          genre_id: 11,
          code_number: 9000 + (uniq % 500),
        })
        .expect(201);
      artistB = b.body;

      // First album under artistA claims code_number 1.
      await auth
        .post('/library')
        .send({
          album_title: `Patch Reattr A1 ${uniq}`,
          artist_id: artistA.id,
          label: 'Patch Reattr Label',
          genre_id: 11,
          format_id: 1,
        })
        .expect(201);

      // First album under artistB also claims code_number 1.
      const moving = await auth
        .post('/library')
        .send({
          album_title: `Patch Reattr B1 ${uniq}`,
          artist_id: artistB.id,
          label: 'Patch Reattr Label',
          genre_id: 11,
          format_id: 1,
        })
        .expect(201);
      movingAlbum = moving.body;
      expect(movingAlbum.code_number).toBe(1);
    });

    test('regenerates code_number when it collides under the new artist', async () => {
      // artistA already owns code_number 1, so the move must regenerate.
      const res = await auth.patch(`/library/${movingAlbum.id}`).send({ artist_id: artistA.id }).expect(200);
      expect(res.body.artist_name).toBe(`Patch Reattr Artist A ${uniq}`);
      expect(res.body.code_number).toBe(2);
    });

    test('keeps code_number when the new artist has no collision', async () => {
      // artistB is empty again after the move; code_number 2 carries over.
      const res = await auth.patch(`/library/${movingAlbum.id}`).send({ artist_id: artistB.id }).expect(200);
      expect(res.body.artist_name).toBe(`Patch Reattr Artist B ${uniq}`);
      expect(res.body.code_number).toBe(2);
    });
  });

  // BS#2564: makes code_number and code_volume_letters writable via PATCH,
  // with an artist-scoped collision check on the (artist_id, code_number,
  // code_volume_letters) tuple — mirroring the shelf-slot key
  // `jobs/library-call-number-dedup` merges duplicates on, so a PATCH can't
  // create the collision that job exists to drain.
  describe('code_number and code_volume_letters (BS#2564)', () => {
    let artist;
    let otherArtist;
    let base;
    let baseLettered;

    const mkAlbum = async (artist_id, code_number, code_volume_letters, title) => {
      const body = {
        album_title: title,
        artist_id,
        label: 'Patch Code Conflict Label',
        genre_id: 11,
        format_id: 1,
        code_number,
      };
      if (code_volume_letters !== undefined) body.code_volume_letters = code_volume_letters;
      const res = await auth.post('/library').send(body).expect(201);
      return res.body;
    };

    beforeAll(async () => {
      const a = await auth
        .post('/library/artists')
        .send({
          artist_name: `Patch Code Conflict Artist ${uniq}`,
          code_letters: 'PE',
          genre_id: 11,
          code_number: 9200 + (uniq % 500),
        })
        .expect(201);
      artist = a.body;

      const b = await auth
        .post('/library/artists')
        .send({
          artist_name: `Patch Code Conflict Artist Other ${uniq}`,
          code_letters: 'PF',
          genre_id: 11,
          code_number: 9200 + (uniq % 500),
        })
        .expect(201);
      otherArtist = b.body;

      base = await mkAlbum(artist.id, 1, undefined, `Patch Code Base ${uniq}`);
      baseLettered = await mkAlbum(artist.id, 1, 'A', `Patch Code Base Lettered ${uniq}`);
    });

    test.each([
      ['same code_number, both null volume letters', { code_number: 1 }, () => base],
      [
        'same code_number, empty-string volume letters treated as null',
        { code_number: 1, code_volume_letters: '' },
        () => base,
      ],
      [
        'same code_number and letters, compared case-insensitively',
        { code_number: 1, code_volume_letters: 'a' },
        () => baseLettered,
      ],
    ])('%s collides with the existing release (409)', async (_desc, patch, conflicting) => {
      const target = await mkAlbum(artist.id, 50, undefined, `Patch Code Target ${uniq}`);

      const res = await auth.patch(`/library/${target.id}`).send(patch).expect(409);
      expect(res.body.reason).toBe('album_code_conflict');
      expect(res.body.album.id).toBe(conflicting().id);
    });

    test.each([
      ['a different code_number', { code_number: 2 }],
      ['the same code_number but distinguishing volume letters', { code_number: 1, code_volume_letters: 'Z' }],
    ])('%s is written without a conflict', async (_desc, patch) => {
      const target = await mkAlbum(artist.id, 50, undefined, `Patch Code Target ${uniq}`);

      const res = await auth.patch(`/library/${target.id}`).send(patch).expect(200);
      expect(res.body.code_number).toBe(patch.code_number);
      if (patch.code_volume_letters !== undefined) {
        expect(res.body.code_volume_letters).toBe(patch.code_volume_letters);
      }
    });

    test('does not collide with an identical tuple filed under a different artist', async () => {
      // artist already owns (code_number: 1, code_volume_letters: null) via
      // `base`, but the check is artist-scoped, so otherArtist can hold the
      // same tuple free of charge.
      const target = await mkAlbum(otherArtist.id, 50, undefined, `Patch Code Target Scope ${uniq}`);

      const res = await auth.patch(`/library/${target.id}`).send({ code_number: 1 }).expect(200);
      expect(res.body.code_number).toBe(1);
    });

    test('rejects an out-of-range code_number and an over-length code_volume_letters', async () => {
      const target = await mkAlbum(artist.id, 51, undefined, `Patch Code Target Validate ${uniq}`);

      const badNumber = await auth.patch(`/library/${target.id}`).send({ code_number: 0 }).expect(400);
      expectErrorContains(badNumber, 'code_number');

      const badLetters = await auth.patch(`/library/${target.id}`).send({ code_volume_letters: 'TOOLONG' }).expect(400);
      expectErrorContains(badLetters, 'code_volume_letters');
    });
  });
});

describe('GET /library/artists/search — review-feedback regressions (PR #1154)', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('repeated q keys return 400 instead of 500', async () => {
    // Express's `simple` query parser yields string[] for repeated keys.
    await auth.get('/library/artists/search?genre_id=11&q=Bu&q=lt').expect(400);
  });

  test('unknown genre_id returns 404 instead of silent empty results', async () => {
    const res = await auth.get('/library/artists/search').query({ genre_id: 99999999, q: 'Bu' }).expect(404);
    expectErrorContains(res, 'genre');
  });

  test('ILIKE metacharacters in q are matched literally', async () => {
    // Pre-fix, '%u' built the pattern '%u%' and returned any artist
    // containing 'u'; escaped, it must prefix-match a literal '%u' (nobody).
    const res = await auth.get('/library/artists/search').query({ genre_id: 11, q: '%u' }).expect(200);
    expect(res.body.artists.length).toBe(0);
  });
});
