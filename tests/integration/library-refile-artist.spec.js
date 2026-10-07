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
 * section (409, row unchanged), and the strict body. The `catalog: write` role gate is pinned in
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

  const seedRelease = async (artistId, genreId, title) => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (${artistId}, ${genreId}, 1, ${`${PREFIX} ${title}`}, 1) RETURNING id`;
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
    expect(wrongGenre.body.message).toContain(`Artist not filed under genre ${SOUNDTRACKS}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toContain('Artist not found');
  });

  it('refuses a lettered compilation section with 409, leaving the row unchanged', async () => {
    const id = await seedArtist('Section', 'V/A', [[SOUNDTRACKS, 0, LETTER]]);

    const res = await refile(id, { genre_id: SOUNDTRACKS, code_artist_number: 5 });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('lettered_compilation_section');
    expect(await codeOf(id, SOUNDTRACKS)).toBe(0);
  });

  it('rejects a body key the endpoint does not support with 400', async () => {
    const id = await seedArtist('Strict', 'ZR', [[HIPHOP, 80]]);

    const res = await refile(id, { genre_id: HIPHOP, code_artist_number: 81, code_letters: 'ZZ' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('code_letters');
  });
});
