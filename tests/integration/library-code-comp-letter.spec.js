/**
 * BS#2835 (epic BS#2828) -- `genre_artist_crossreference.code_comp_letter` on every read that serves a shelf
 * slot's artist number. A lettered `V/A` compilation section (artist_genre_code 0, letter 'Y' here) answers
 * with its letter on each endpoint family; a named artist answers `null`.
 *
 * Seeds one lettered V/A artist and one named artist in genre 12 ('Soundtracks'), each with one release, and
 * removes every row in `afterAll`. The letter is 'Y' and the genre 12 because the unique index on
 * `(genre_id, code_comp_letter)` would refuse a second 'Y' there, and the 2833 spec uses 'Q'.
 *
 * Covers: `GET /library/query` (SQL tier), `GET /library/info`, `GET /library/artists/by-code` (full and browse),
 * `GET /library/artists/search`, and `POST /library/filings` `kind: 'existing'`. The track-cascade tier is a
 * mapper over the same view projection (unit-tested in `library-search.code-comp-letter.test.ts`).
 */
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb, closeTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE = 12; // 'Soundtracks'
const FORMAT = 1; // 'cd'
const LETTER = 'Y';
const TOKEN = 'Quillfeather';
const LETTERED_ARTIST = `${TOKEN} Various Artists - ${LETTER}`;
const NAMED_ARTIST = `${TOKEN} Named Artist`;
const LETTERED_ALBUM = `${TOKEN} Lettered Compilation`;
const NAMED_ALBUM = `${TOKEN} Named Album`;

describe('code_comp_letter on slot-serving reads (BS#2835)', () => {
  let auth;
  let sql;
  const seeded = { letteredArtist: 0, namedArtist: 0, letteredAlbum: 0, namedAlbum: 0 };

  const seedArtist = async (name, codeLetters, artistGenreCode, letter) => {
    const [artist] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${name}, ${name}, ${codeLetters}) RETURNING id
    `;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code, code_comp_letter)
      VALUES (${artist.id}, ${GENRE}, ${artistGenreCode}, ${letter})
    `;
    return artist.id;
  };

  const seedAlbum = async (artistId, title) => {
    const [album] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (${artistId}, ${GENRE}, ${FORMAT}, ${title}, 1) RETURNING id
    `;
    return album.id;
  };

  const cleanup = async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE album_title LIKE ${`${TOKEN}%`}`;
    const artists = await sql`SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${`${TOKEN}%`}`;
    const ids = artists.map((a) => a.id);
    if (ids.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id IN ${sql(ids)}`;
      await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id IN ${sql(ids)}`;
    }
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
    await cleanup();
    seeded.letteredArtist = await seedArtist(LETTERED_ARTIST, 'V/A', 0, LETTER);
    seeded.namedArtist = await seedArtist(NAMED_ARTIST, 'BSZ', 7, null);
    seeded.letteredAlbum = await seedAlbum(seeded.letteredArtist, LETTERED_ALBUM);
    seeded.namedAlbum = await seedAlbum(seeded.namedArtist, NAMED_ALBUM);
  });

  afterAll(async () => {
    await cleanup();
    await closeTestDb();
  });

  test('GET /library/query carries the letter for a lettered slot and null for a named artist', async () => {
    const res = await auth.get('/library/query').query({ q: TOKEN, limit: 10 }).expect(200);

    const lettered = res.body.results.find((r) => r.id === seeded.letteredAlbum);
    const named = res.body.results.find((r) => r.id === seeded.namedAlbum);
    expect(lettered).toMatchObject({ code_artist_number: 0, code_comp_letter: LETTER });
    expect(named).toMatchObject({ code_artist_number: 7, code_comp_letter: null });
  });

  test('GET /library/info carries the letter for a lettered slot and null for a named artist', async () => {
    const lettered = await auth.get('/library/info').query({ album_id: seeded.letteredAlbum }).expect(200);
    const named = await auth.get('/library/info').query({ album_id: seeded.namedAlbum }).expect(200);

    expect(lettered.body.code_comp_letter).toBe(LETTER);
    expect(named.body.code_comp_letter).toBeNull();
  });

  test('GET /library/artists/by-code carries the letter on both the fully-specified and browse modes', async () => {
    const full = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: GENRE, code_letters: 'V/A', code_number: 0 })
      .expect(200);
    const browse = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: GENRE, code_letters: 'V/A' })
      .expect(200);
    const named = await auth
      .get('/library/artists/by-code')
      .query({ genre_id: GENRE, code_letters: 'BSZ', code_number: 7 })
      .expect(200);

    expect(full.body.artists.find((a) => a.id === seeded.letteredArtist)).toMatchObject({ code_comp_letter: LETTER });
    expect(browse.body.artists.find((a) => a.id === seeded.letteredArtist)).toMatchObject({
      code_comp_letter: LETTER,
    });
    expect(named.body.artists).toEqual([expect.objectContaining({ id: seeded.namedArtist, code_comp_letter: null })]);
  });

  test('GET /library/artists/search carries the letter beside code_number', async () => {
    const res = await auth.get('/library/artists/search').query({ q: TOKEN, genre_id: GENRE }).expect(200);

    expect(res.body.artists.find((a) => a.id === seeded.letteredArtist)).toMatchObject({
      code_number: 0,
      code_comp_letter: LETTER,
    });
    expect(res.body.artists.find((a) => a.id === seeded.namedArtist)).toMatchObject({
      code_number: 7,
      code_comp_letter: null,
    });
  });

  test("POST /library/filings kind 'existing' answers the slot's letter on the artist block", async () => {
    const lettered = await auth
      .post('/library/filings')
      .send({
        artist: { kind: 'existing', artist_id: seeded.letteredArtist },
        release: {
          album_title: `${TOKEN} Filed Under Letter`,
          label: 'Test Label',
          genre_id: GENRE,
          format_id: FORMAT,
        },
      })
      .expect(200);
    const named = await auth
      .post('/library/filings')
      .send({
        artist: { kind: 'existing', artist_id: seeded.namedArtist },
        release: { album_title: `${TOKEN} Filed Under Name`, label: 'Test Label', genre_id: GENRE, format_id: FORMAT },
      })
      .expect(200);

    expect(lettered.body.artist).toMatchObject({ id: seeded.letteredArtist, code_comp_letter: LETTER });
    expect(named.body.artist).toMatchObject({ id: seeded.namedArtist, code_comp_letter: null });
  });
});
