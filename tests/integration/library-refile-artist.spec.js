/**
 * Integration tests for POST /library/artists/:id/refile (BS#2643), against real Postgres.
 *
 * Seeds its own artists under the code letters `ZR`/`ZS` (genre 6 'Hiphop', genre 11 'Rock', genre 12
 * 'Soundtracks' for the lettered section) and removes every row in `afterAll`.
 *
 * Covers Bill's case (the Hiphop Isis, `IS 1` -> `IS 31`, release re-labels with no release edit, the Rock
 * membership untouched), an occupied slot with two owners inserted in reverse name order (the 409 names the
 * alphabetically-first one, stably), the no-op (200 `changed: false` and the catalog watermark unmoved, proving no
 * UPDATE was issued), the no-op for an artist sharing a contested triple, the two 404s, a lettered compilation
 * section (409, row unchanged), and the strict body. The re-letter (BS#3035) cases are in the `re-letter` block below. The `catalog: write` role gate is pinned in
 * tests/unit/routes/library-artist-card-permissions.route.test.ts: this tier runs AUTH_BYPASS, which cannot express a
 * role refusal.
 */
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { managerAccessToken } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-REFILE';
const HIPHOP = 6;
const ROCK = 11;
const SOUNDTRACKS = 12;
const LETTER = 'V';
const JAZZ = 7;
const ELECTRONIC = 15;

describe('POST /library/artists/:id/refile (BS#2643)', () => {
  let manager;
  let sql;

  const seedArtist = async (name, codeLetters, memberships) => {
    const [artist] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${`${PREFIX} ${name}`}, ${`${PREFIX} ${name}`}, ${codeLetters}) RETURNING id`;
    for (const [genreId, code, letter = null] of memberships) {
      await sql`
        INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code, code_comp_letter)
        VALUES (${artist.id}, ${genreId}, ${code}, ${letter})`;
    }
    return artist.id;
  };

  const seedRelease = async (artistId, genreId, title, codeNumber = 1) => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (${artistId}, ${genreId}, 1, ${`${PREFIX} ${title}`}, ${codeNumber}) RETURNING id`;
    return row.id;
  };

  const codeOf = async (artistId, genreId) => {
    const [row] = await sql`
      SELECT artist_genre_code FROM ${sql(SCHEMA)}.genre_artist_crossreference
      WHERE artist_id = ${artistId} AND genre_id = ${genreId}`;
    return row?.artist_genre_code;
  };

  const watermark = async () => {
    const [row] = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
    return row.last_modified_at.getTime();
  };

  const cleanup = async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE album_title LIKE ${`${PREFIX}%`}`;
    const ids = (await sql`SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${`${PREFIX}%`}`).map(
      (a) => a.id
    );
    if (ids.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id IN ${sql(ids)}`;
      await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id IN ${sql(ids)}`;
    }
  };

  const refile = (artistId, body, as = manager) => as.post(`/library/artists/${artistId}/refile`).send(body);

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    sql = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  it("re-files Bill's case: IS 1 -> 31 in Hiphop, release re-labels, the Rock membership is untouched", async () => {
    const id = await seedArtist('Isis', 'ZR', [
      [HIPHOP, 1],
      [ROCK, 13],
    ]);
    await seedRelease(id, HIPHOP, 'Isis Release');

    const res = await refile(id, { genre_id: HIPHOP, code_artist_number: 31 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      artist_id: id,
      genre_id: HIPHOP,
      code_letters: 'ZR',
      code_artist_number: 31,
      changed: true,
      previous_code_artist_number: 1,
      releases_to_relabel: 1,
    });
    const releases = await manager.get(`/library/artists/${id}/releases`).query({ genre_id: HIPHOP });
    expect(releases.status).toBe(200);
    expect(releases.body.releases.map((r) => r.code_artist_number)).toEqual([31]);
    expect(await codeOf(id, ROCK)).toBe(13);
  });

  it('409s on an occupied slot naming the alphabetically-first owner, stably, and writes nothing', async () => {
    // Inserted in reverse name order so id order and name order disagree.
    const zed = await seedArtist('Zed Owner', 'ZS', [[HIPHOP, 40]]);
    const abe = await seedArtist('Abe Owner', 'ZS', [[HIPHOP, 40]]);
    const mover = await seedArtist('Mover', 'ZS', [[HIPHOP, 41]]);

    const first = await refile(mover, { genre_id: HIPHOP, code_artist_number: 40 });
    const second = await refile(mover, { genre_id: HIPHOP, code_artist_number: 40 });

    for (const res of [first, second]) {
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('artist_code_conflict');
      expect(res.body.artist).toMatchObject({
        id: abe,
        artist_name: `${PREFIX} Abe Owner`,
        code_letters: 'ZS',
        code_artist_number: 40,
        genre_id: HIPHOP,
      });
      expect(res.body.artist).not.toHaveProperty('artist_id');
    }
    expect(abe).toBeGreaterThan(zed);
    expect(await codeOf(mover, HIPHOP)).toBe(41);
  });

  it('answers a same-number resubmit 200 changed:false and does not advance the catalog watermark', async () => {
    const id = await seedArtist('Steady', 'ZR', [[HIPHOP, 50]]);
    await seedRelease(id, HIPHOP, 'Steady Release');
    const before = await watermark();

    const res = await refile(id, { genre_id: HIPHOP, code_artist_number: 50 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: false, previous_code_artist_number: 50, releases_to_relabel: 1 });
    expect(await watermark()).toBe(before);
  });

  it('answers a same-number resubmit 200 for an artist sharing a contested triple with a co-owner', async () => {
    const a = await seedArtist('Twin A', 'ZR', [[HIPHOP, 60]]);
    await seedArtist('Twin B', 'ZR', [[HIPHOP, 60]]);

    const res = await refile(a, { genre_id: HIPHOP, code_artist_number: 60 });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
  });

  it('distinguishes the two 404s', async () => {
    const id = await seedArtist('Elsewhere', 'ZR', [[HIPHOP, 70]]);

    const wrongGenre = await refile(id, { genre_id: SOUNDTRACKS, code_artist_number: 1 });
    const unknown = await refile(2147483000, { genre_id: HIPHOP, code_artist_number: 1 });

    expect(wrongGenre.status).toBe(404);
    expect(wrongGenre.body).toEqual({
      message: `Artist not filed under genre ${SOUNDTRACKS}`,
      code: 'artist_not_filed_in_genre',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ message: 'Artist not found', code: 'artist_not_found' });
  });

  it('refuses a lettered compilation section with 409, leaving the row unchanged', async () => {
    const id = await seedArtist('Section', 'V/A', [[SOUNDTRACKS, 0, LETTER]]);

    const res = await refile(id, { genre_id: SOUNDTRACKS, code_artist_number: 5 });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('lettered_compilation_section');
    expect(await codeOf(id, SOUNDTRACKS)).toBe(0);
  });

  it.each(['V/A', 'Z-R'])(
    'refuses a Various Artists bucket (%s) with 409, even for its own number, writing nothing',
    async (letters) => {
      const id = await seedArtist('Bucket', letters, [[HIPHOP, 5]]);
      const before = await watermark();

      for (const number of [5, 9]) {
        const res = await refile(id, { genre_id: HIPHOP, code_artist_number: number });

        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('various_artists_section');
        expect(res.body).not.toHaveProperty('artist');
      }
      expect(await codeOf(id, HIPHOP)).toBe(5);
      expect(await watermark()).toBe(before);
    }
  );

  it('rejects a body key the endpoint does not support with 400', async () => {
    const id = await seedArtist('Strict', 'ZR', [[HIPHOP, 80]]);

    const res = await refile(id, { genre_id: HIPHOP, code_artist_number: 81, bogus_key: ROCK });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('bogus_key');
  });

  describe('re-letter (BS#3035)', () => {
    const lettersOf = async (artistId) => {
      const [row] = await sql`SELECT code_letters, last_modified FROM ${sql(SCHEMA)}.artists WHERE id = ${artistId}`;
      return row;
    };

    it("re-letters Bill's case: ZE 36 -> ZJ 36, previous letters reported, the release reads ZJ 36", async () => {
      const id = await seedArtist('Jam Money', 'ZE', [[HIPHOP, 36]]);
      await seedRelease(id, HIPHOP, 'Jam Money Release');

      const res = await refile(id, { genre_id: HIPHOP, code_letters: 'ZJ', code_artist_number: 36 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        artist_id: id,
        genre_id: HIPHOP,
        code_letters: 'ZJ',
        code_artist_number: 36,
        changed: true,
        previous_code_letters: 'ZE',
        previous_genre_id: HIPHOP,
        previous_code_artist_number: 36,
        releases_to_relabel: 1,
      });
      const releases = await manager.get(`/library/artists/${id}/releases`).query({ genre_id: HIPHOP });
      expect(releases.body.releases[0]).toMatchObject({ code_letters: 'ZJ', code_artist_number: 36 });
    });

    it('re-letters and re-numbers in one request, storing trimmed upper-case letters, and advances last_modified', async () => {
      const id = await seedArtist('Both', 'ZE', [[HIPHOP, 50]]);
      const before = await lettersOf(id);

      const res = await refile(id, { genre_id: HIPHOP, code_letters: ' zj ', code_artist_number: 51 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ code_letters: 'ZJ', code_artist_number: 51, previous_code_artist_number: 50 });
      const after = await lettersOf(id);
      expect(after.code_letters).toBe('ZJ');
      expect(after.last_modified.getTime()).toBeGreaterThan(before.last_modified.getTime());
    });

    it('409s on an occupied ZJ 60 naming the holder; nothing written, watermark and last_modified unchanged', async () => {
      const holder = await seedArtist('Holder', 'ZJ', [[HIPHOP, 60]]);
      const mover = await seedArtist('Mover', 'ZE', [[HIPHOP, 60]]);
      const before = await lettersOf(mover);
      const mark = await watermark();

      const res = await refile(mover, { genre_id: HIPHOP, code_letters: ' zj ', code_artist_number: 60 });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('artist_code_conflict');
      expect(res.body.artist).toMatchObject({ id: holder, code_letters: 'ZJ', code_artist_number: 60 });
      expect(await watermark()).toBe(mark);
      const after = await lettersOf(mover);
      expect(after.code_letters).toBe('ZE');
      expect(after.last_modified.getTime()).toBe(before.last_modified.getTime());
    });

    it('409s letters_shared_across_genres for a multi-genre artist, listing both memberships, writing nothing', async () => {
      const id = await seedArtist('Two Genres', 'ZE', [
        [HIPHOP, 70],
        [ROCK, 71],
      ]);
      const mark = await watermark();

      const res = await refile(id, { genre_id: HIPHOP, code_letters: 'ZJ', code_artist_number: 70 });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('letters_shared_across_genres');
      expect(res.body.memberships).toEqual([
        { genre_id: HIPHOP, code_artist_number: 70 },
        { genre_id: ROCK, code_artist_number: 71 },
      ]);
      expect((await lettersOf(id)).code_letters).toBe('ZE');
      expect(await watermark()).toBe(mark);
    });

    it('409s letters_shared_across_genres for a single membership with a stray release in another genre', async () => {
      const id = await seedArtist('Stray', 'ZE', [[HIPHOP, 80]]);
      await seedRelease(id, ROCK, 'Stray Release');
      const mark = await watermark();

      const res = await refile(id, { genre_id: HIPHOP, code_letters: 'ZJ', code_artist_number: 80 });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('letters_shared_across_genres');
      expect(res.body.memberships).toEqual([{ genre_id: HIPHOP, code_artist_number: 80 }]);
      expect((await lettersOf(id)).code_letters).toBe('ZE');
      expect(await watermark()).toBe(mark);
    });

    it.each([
      ['a lettered compilation section', 'V/A', SOUNDTRACKS, 0, 'W', 'lettered_compilation_section'],
      ['a Various Artists source bucket', 'Z-R', HIPHOP, 5, null, 'various_artists_section'],
    ])(
      'refuses a re-letter of %s with the source-section 409, writing nothing',
      async (_n, letters, genre, number, letter, reason) => {
        const id = await seedArtist(`Source ${reason}`, letters, [[genre, number, letter]]);
        const mark = await watermark();

        const res = await refile(id, { genre_id: genre, code_letters: 'ZJ', code_artist_number: number });

        expect(res.status).toBe(409);
        expect(res.body.reason).toBe(reason);
        expect((await lettersOf(id)).code_letters).toBe(letters);
        expect(await watermark()).toBe(mark);
      }
    );

    it('sending the current letters back is not a change: same number 200 changed:false, new number a plain re-number', async () => {
      const id = await seedArtist('Same Letters', 'ZE', [
        [HIPHOP, 90],
        [ROCK, 91],
      ]);
      const mark = await watermark();
      const stamped = await lettersOf(id);

      const same = await refile(id, { genre_id: HIPHOP, code_letters: 'ze', code_artist_number: 90 });
      expect(same.status).toBe(200);
      expect(same.body).toMatchObject({ changed: false, code_letters: 'ZE', previous_code_letters: 'ZE' });
      expect(await watermark()).toBe(mark);
      expect((await lettersOf(id)).last_modified.getTime()).toBe(stamped.last_modified.getTime());

      // A multi-genre artist may re-number; the unchanged letters keep it out of the re-letter refusal.
      const renumbered = await refile(id, { genre_id: HIPHOP, code_letters: 'ze', code_artist_number: 92 });
      expect(renumbered.status).toBe(200);
      expect(renumbered.body).toMatchObject({ changed: true, code_letters: 'ZE', code_artist_number: 92 });
      expect(await codeOf(id, ROCK)).toBe(91);
    });
  });

  describe('genre move (BS#3036)', () => {
    const releaseRows = async (artistId) =>
      sql`SELECT id, genre_id, code_number, last_modified FROM ${sql(SCHEMA)}.library WHERE artist_id = ${artistId} ORDER BY id`;
    const body = (extra) => ({ genre_id: JAZZ, to_genre_id: ELECTRONIC, code_artist_number: 4, ...extra });

    it('moves the membership and both releases: Jazz ZG 36 to Electronic ZG 4, code numbers kept, last_modified bumped', async () => {
      const id = await seedArtist('Mover', 'ZG', [[JAZZ, 36]]);
      await seedRelease(id, JAZZ, 'First', 1);
      await seedRelease(id, JAZZ, 'Second', 2);
      const before = await releaseRows(id);

      const res = await refile(id, body());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        artist_id: id,
        genre_id: ELECTRONIC,
        code_letters: 'ZG',
        code_artist_number: 4,
        changed: true,
        previous_genre_id: JAZZ,
        previous_code_artist_number: 36,
        previous_code_letters: 'ZG',
        releases_to_relabel: 2,
      });
      const after = await releaseRows(id);
      expect(after.map((r) => [r.genre_id, r.code_number])).toEqual([
        [ELECTRONIC, 1],
        [ELECTRONIC, 2],
      ]);
      after.forEach((r, i) => expect(r.last_modified.getTime()).toBeGreaterThan(before[i].last_modified.getTime()));
      expect(await codeOf(id, ELECTRONIC)).toBe(4);
      expect(await codeOf(id, JAZZ)).toBeUndefined();
      const old = await manager.get(`/library/artists/${id}`).query({ genre_id: JAZZ });
      expect(old.status).toBe(404);
      expect(old.body.message).toContain(`not filed under genre ${JAZZ}`);
    });

    it('moves with the same number (genre only) and with letters, number and genre in one request', async () => {
      const a = await seedArtist('Genre Only', 'ZG', [[JAZZ, 45]]);
      const only = await refile(a, body({ code_artist_number: 45 }));
      expect(only.status).toBe(200);
      expect(only.body).toMatchObject({ changed: true, genre_id: ELECTRONIC, code_artist_number: 45 });

      const b = await seedArtist('Everything', 'ZG', [[JAZZ, 46]]);
      await seedRelease(b, JAZZ, 'Everything Release');
      const all = await refile(b, body({ code_letters: 'zh', code_artist_number: 47 }));
      expect(all.status).toBe(200);
      expect(all.body).toMatchObject({
        genre_id: ELECTRONIC,
        code_letters: 'ZH',
        code_artist_number: 47,
        previous_code_letters: 'ZG',
        previous_genre_id: JAZZ,
        releases_to_relabel: 1,
      });
    });

    it("leaves the artist's other membership and its releases untouched", async () => {
      const id = await seedArtist('Two Homes', 'ZG', [
        [JAZZ, 50],
        [ROCK, 51],
      ]);
      await seedRelease(id, JAZZ, 'Jazz Release');
      const rockRelease = await seedRelease(id, ROCK, 'Rock Release');
      const [rockBefore] =
        await sql`SELECT genre_id, last_modified FROM ${sql(SCHEMA)}.library WHERE id = ${rockRelease}`;

      const res = await refile(id, body({ code_artist_number: 5 }));

      expect(res.status).toBe(200);
      expect(await codeOf(id, ROCK)).toBe(51);
      const [rockAfter] =
        await sql`SELECT genre_id, last_modified FROM ${sql(SCHEMA)}.library WHERE id = ${rockRelease}`;
      expect(rockAfter.genre_id).toBe(ROCK);
      expect(rockAfter.last_modified.getTime()).toBe(rockBefore.last_modified.getTime());
    });

    it('refuses already_filed_in_genre for a membership at the destination, writing nothing', async () => {
      const id = await seedArtist('Both Genres', 'ZG', [
        [JAZZ, 60],
        [ELECTRONIC, 61],
      ]);
      const release = await seedRelease(id, JAZZ, 'Jazz Release');
      const mark = await watermark();

      const res = await refile(id, body());

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('already_filed_in_genre');
      expect(await codeOf(id, JAZZ)).toBe(60);
      const [row] = await sql`SELECT genre_id FROM ${sql(SCHEMA)}.library WHERE id = ${release}`;
      expect(row.genre_id).toBe(JAZZ);
      expect(await watermark()).toBe(mark);
    });

    it('refuses already_filed_in_genre for a release at the destination with no membership row', async () => {
      const id = await seedArtist('Stray Dest', 'ZG', [[JAZZ, 70]]);
      await seedRelease(id, ELECTRONIC, 'Stray Release');
      const mark = await watermark();

      const res = await refile(id, body());

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('already_filed_in_genre');
      expect(await codeOf(id, JAZZ)).toBe(70);
      expect(await watermark()).toBe(mark);
    });

    it('refuses an occupied destination slot naming the holder, and an unknown genre with 404 genre_not_found', async () => {
      const holder = await seedArtist('Holder', 'ZG', [[ELECTRONIC, 4]]);
      const id = await seedArtist('Blocked', 'ZG', [[JAZZ, 80]]);

      const taken = await refile(id, body());
      expect(taken.status).toBe(409);
      expect(taken.body.reason).toBe('artist_code_conflict');
      expect(taken.body.artist).toMatchObject({ id: holder, genre_id: ELECTRONIC, code_artist_number: 4 });
      expect(await codeOf(id, JAZZ)).toBe(80);

      const unknown = await refile(id, body({ to_genre_id: 9999 }));
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('genre_not_found');
    });

    it('treats to_genre_id equal to genre_id as a number-only re-file', async () => {
      const id = await seedArtist('Same Genre', 'ZG', [[JAZZ, 90]]);

      const res = await refile(id, body({ to_genre_id: JAZZ, code_artist_number: 91 }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ genre_id: JAZZ, code_artist_number: 91, previous_genre_id: JAZZ });
    });

    it.each([
      ['a lettered compilation section', 'V/A', SOUNDTRACKS, 0, 'X', 'lettered_compilation_section'],
      ['a Various Artists bucket', 'V/A', HIPHOP, 5, null, 'various_artists_section'],
    ])('refuses moving out of %s, writing nothing', async (_n, letters, genre, number, letter, reason) => {
      const id = await seedArtist(`Move ${reason}`, letters, [[genre, number, letter]]);
      const mark = await watermark();

      const res = await refile(id, { genre_id: genre, to_genre_id: ELECTRONIC, code_artist_number: number });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe(reason);
      expect(await codeOf(id, genre)).toBe(number);
      expect(await watermark()).toBe(mark);
    });
  });
});
