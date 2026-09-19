const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains, expectFields } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

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
  // reusing the shared BS#2410 validators so the two write surfaces (POST
  // /library, PATCH /library/:id) can't disagree on bounds. No collision
  // check — that was split out (see the PR body); a colliding write just
  // writes, same as POST /library always has.
  describe('code_number and code_volume_letters (BS#2564)', () => {
    let artist;

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
    });

    test.each([
      ['a code_number', { code_number: 2 }],
      ['a code_number with distinguishing volume letters', { code_number: 1, code_volume_letters: 'Z' }],
    ])('%s is written on PATCH', async (_desc, patch) => {
      const target = await mkAlbum(artist.id, 50, undefined, `Patch Code Target ${uniq}`);

      const res = await auth.patch(`/library/${target.id}`).send(patch).expect(200);
      expect(res.body.code_number).toBe(patch.code_number);
      if (patch.code_volume_letters !== undefined) {
        expect(res.body.code_volume_letters).toBe(patch.code_volume_letters);
      }
    });

    test('rejects an out-of-range code_number and an over-length code_volume_letters', async () => {
      const target = await mkAlbum(artist.id, 51, undefined, `Patch Code Target Validate ${uniq}`);

      const badNumber = await auth.patch(`/library/${target.id}`).send({ code_number: 0 }).expect(400);
      expectErrorContains(badNumber, 'code_number');

      const badLetters = await auth.patch(`/library/${target.id}`).send({ code_volume_letters: 'TOOLONG' }).expect(400);
      expectErrorContains(badLetters, 'code_volume_letters');
    });

    // GET emits code_volume_letters as nullable:true, so a client that
    // round-trips a GET body straight into a PATCH must be able to send
    // back the null it just received, rather than 400ing on it.
    test('code_volume_letters: null clears the letters explicitly', async () => {
      const target = await mkAlbum(artist.id, 52, 'A', `Patch Code Target Clear ${uniq}`);
      expect(target.code_volume_letters).toBe('A');

      const res = await auth.patch(`/library/${target.id}`).send({ code_volume_letters: null }).expect(200);
      expect(res.body.code_volume_letters).toBeNull();
    });

    // The other documented clearing spelling (app.yaml: "an empty string or
    // an explicit null clears it to NULL") — the librarian who empties the
    // volume-letters box rather than sending a JSON null. This is the only
    // case that reaches the `?? null` coalesce; an explicit null takes the
    // other ternary branch, so without it the coalesce could be deleted and
    // the clear would answer 200 with the old letters still stored.
    test('code_volume_letters: an empty string clears the letters to NULL', async () => {
      const target = await mkAlbum(artist.id, 53, 'A', `Patch Code Target Clear Blank ${uniq}`);
      expect(target.code_volume_letters).toBe('A');

      const res = await auth.patch(`/library/${target.id}`).send({ code_volume_letters: '' }).expect(200);
      expect(res.body.code_volume_letters).toBeNull();
    });

    // #1555 no-op short-circuit, end to end over the real SELECT: a
    // full-record Save that resubmits the stored letters must not run an
    // UPDATE. `getLibraryRowById` has to project code_volume_letters for the
    // comparison to work — without it the stored 'B' compares against
    // `undefined`, the handler sees a change, and the UPDATE's SET list
    // (carrying album_title) advances the catalog watermark, forcing every
    // iOS / dj-site poller into a full re-download for a write that changed
    // nothing.
    test('resubmitting the stored code_volume_letters runs no UPDATE', async () => {
      const target = await mkAlbum(artist.id, 54, 'B', `Patch Code Target Echo ${uniq}`);
      expect(target.code_volume_letters).toBe('B');

      const before = await auth.get('/library/info').query({ album_id: target.id }).expect(200);

      const res = await auth
        .patch(`/library/${target.id}`)
        .send({ album_title: before.body.album_title, code_volume_letters: 'B' })
        .expect(200);

      expect(res.body.code_volume_letters).toBe('B');
      // updateAlbumInDB always SETs last_modified = NOW(), so an unchanged
      // timestamp is the proof that no UPDATE ran.
      expect(new Date(res.body.last_modified).getTime()).toBe(new Date(before.body.last_modified).getTime());
    });
  });

  // BS#2564 finding 2: an explicit code_number supplied alongside an
  // artist_id move must win over the pre-existing auto-regenerate (review
  // issue 7) — that block tests the row's OLD code_number, which the
  // operator's new explicit value makes irrelevant.
  describe('artist move with an explicit code_number (BS#2564 finding 2)', () => {
    let destArtist;
    let originArtist;

    beforeAll(async () => {
      // Synthetic names, not real WXYC artists: `Stereolab`/`Cat Power` are
      // permanent seed fixtures other suites prefix-match on exact name
      // (`dev_env/seed_db.sql`, `library-query.spec.js`'s `artist:Stereolab`
      // filter), and this row's uniq suffix would still match that prefix.
      const dest = await auth
        .post('/library/artists')
        .send({
          artist_name: `Patch Explicit Move Dest Artist ${uniq}`,
          code_letters: 'SL',
          genre_id: 11,
          code_number: 9350 + (uniq % 500),
        })
        .expect(201);
      destArtist = dest.body;

      const origin = await auth
        .post('/library/artists')
        .send({
          artist_name: `Patch Explicit Move Origin Artist ${uniq}`,
          code_letters: 'CP',
          genre_id: 11,
          code_number: 9350 + (uniq % 500),
        })
        .expect(201);
      originArtist = origin.body;

      // destArtist already owns code_number 1 — the auto-regenerate's
      // trigger, and the number a bad fix would silently hand back instead
      // of the operator's explicit choice.
      await auth
        .post('/library')
        .send({
          album_title: `Explicit Move Dest Existing ${uniq}`,
          artist_id: destArtist.id,
          label: 'Explicit Move Label',
          genre_id: 11,
          format_id: 1,
          code_number: 1,
        })
        .expect(201);
    });

    test('a free destination code_number is written verbatim, not auto-regenerated', async () => {
      const moving = await auth
        .post('/library')
        .send({
          album_title: `Explicit Move Origin A ${uniq}`,
          artist_id: originArtist.id,
          label: 'Explicit Move Label',
          genre_id: 11,
          format_id: 1,
        })
        .expect(201);
      // originArtist's own auto-assigned number happens to collide with
      // destArtist's existing 1 — exactly the shape that fires the
      // pre-existing auto-regenerate if the explicit value below is ignored.
      expect(moving.body.code_number).toBe(1);

      const res = await auth
        .patch(`/library/${moving.body.id}`)
        .send({ artist_id: destArtist.id, code_number: 5 })
        .expect(200);
      expect(res.body.artist_id).toBe(destArtist.id);
      expect(res.body.code_number).toBe(5);
    });

    // The regression the "explicit wins" rule has to stop short of: a
    // code_number echoing the row's own value is what a full-record Save
    // sends whether or not the operator touched the field, so it expresses no
    // destination choice and must still auto-regenerate on collision. Filing
    // two releases into one (artist, code_number) slot would be silent —
    // there is no collision check on this path and no DB constraint (#2033).
    test('a code_number echoing the stored value still auto-regenerates on collision', async () => {
      const moving = await auth
        .post('/library')
        .send({
          album_title: `Explicit Move Origin Echo ${uniq}`,
          artist_id: originArtist.id,
          label: 'Explicit Move Label',
          genre_id: 11,
          format_id: 1,
        })
        .expect(201);
      expect(moving.body.code_number).toBe(1);

      const res = await auth
        .patch(`/library/${moving.body.id}`)
        .send({ artist_id: destArtist.id, code_number: moving.body.code_number })
        .expect(200);
      expect(res.body.artist_id).toBe(destArtist.id);
      // destArtist owns 1 already, so the move burns the next number in its
      // sequence rather than landing on the echoed 1.
      expect(res.body.code_number).toBeGreaterThan(1);
    });
  });

  // BS#2587: `genre_id` is itself in `UPDATABLE_ALBUM_FIELDS`, so a PATCH can
  // move a release to a new artist AND a new genre at once. The auto-regenerate
  // must scope against the DESTINATION genre, not the row's own stored
  // (soon-to-be-stale) genre -- reading `existing.genre_id` would re-file the
  // release onto the shelf it is leaving rather than the one it is landing on.
  //
  // The fixture is deliberately shaped so the genre-scoped answer and the OLD
  // genre-blind answer (MAX(code_number) across every genre the artist is
  // filed under, not just the destination) DIFFER: destArtist's Rock (11)
  // shelf sits much higher than its Electronic (15) shelf, and the moving
  // release lands in Electronic -- the LOW shelf. A genre-blind generator
  // would still see Rock's high max and answer off it; scoped correctly, the
  // destination shelf is nearly empty. (An earlier version of this fixture
  // had it backwards -- destination shelf high, other shelf low -- which
  // happened to make both answers agree and passed unchanged even with the
  // pre-#2587 genre-blind generator.) Reverting the service's genre-scoping
  // fix makes this test's final assertion fail.
  describe('artist move that also changes genre regenerates against the destination genre (BS#2587)', () => {
    let destArtist;
    let originArtist;

    beforeAll(async () => {
      const dest = await auth
        .post('/library/artists')
        .send({
          artist_name: `Patch Genre Move Dest Artist ${uniq}`,
          code_letters: 'GM',
          genre_id: 11,
          code_number: 9450 + (uniq % 500),
        })
        .expect(201);
      destArtist = dest.body;

      // destArtist is filed under a SECOND genre too -- `POST /library/artists`
      // always inserts exactly one crossreference row, so a real multi-genre
      // artist has to be constructed with a direct insert, the same approach
      // the cross-reference fixtures elsewhere in this suite use.
      const sql = getTestDb();
      await sql.unsafe(
        `INSERT INTO ${SCHEMA}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
         VALUES (${destArtist.id}, 15, ${9450 + (uniq % 500)})`
      );

      // destArtist's Rock (11) shelf tops out HIGH -- a genre-blind
      // MAX(code_number) across every genre the artist is filed under would
      // answer off this shelf regardless of where the moving release lands.
      await auth
        .post('/library')
        .send({
          album_title: `Genre Move Dest Rock ${uniq}`,
          artist_id: destArtist.id,
          label: 'Genre Move Label',
          genre_id: 11,
          format_id: 1,
          code_number: 40,
        })
        .expect(201);

      // destArtist's Electronic (15) shelf tops out at 1 -- the DESTINATION
      // the moving release is landing in. A genre-scoped regenerate must
      // answer from HERE (2), not from Rock's much higher shelf (41).
      await auth
        .post('/library')
        .send({
          album_title: `Genre Move Dest Electronic ${uniq}`,
          artist_id: destArtist.id,
          label: 'Genre Move Label',
          genre_id: 15,
          format_id: 1,
          code_number: 1,
        })
        .expect(201);

      const origin = await auth
        .post('/library/artists')
        .send({
          artist_name: `Patch Genre Move Origin Artist ${uniq}`,
          code_letters: 'GO',
          genre_id: 11,
          code_number: 9460 + (uniq % 500),
        })
        .expect(201);
      originArtist = origin.body;
    });

    test('regenerates from the destination genre shelf (2), not the artist-wide max (41)', async () => {
      const moving = await auth
        .post('/library')
        .send({
          album_title: `Genre Move Origin Release ${uniq}`,
          artist_id: originArtist.id,
          label: 'Genre Move Label',
          genre_id: 11,
          format_id: 1,
        })
        .expect(201);
      // originArtist's first release auto-assigns 1, which collides with
      // destArtist's Electronic code_number 1 -- the trigger for the
      // regenerate. `albumCodeNumberTaken` is artist-wide
      // (WXYC/Backend-Service#2579, deliberately not fixed here), so it fires
      // on that collision regardless of which genre either release is filed
      // under -- see the module comment above for that known scope gap.
      expect(moving.body.code_number).toBe(1);

      const res = await auth
        .patch(`/library/${moving.body.id}`)
        .send({ artist_id: destArtist.id, genre_id: 15 })
        .expect(200);

      expect(res.body.artist_id).toBe(destArtist.id);
      expect(res.body.genre_id).toBe(15);
      // 2 = destArtist's Electronic max (1) + 1 -- the destination shelf the
      // release is landing on. A genre-blind regenerate (MAX(code_number)
      // across every genre the artist is filed under, the pre-#2587
      // behavior) would instead answer 41, off Rock's much higher shelf --
      // the exact defect BS#2587 fixed, and the point of shaping the fixture
      // this way rather than the other way around.
      expect(res.body.code_number).toBe(2);
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
