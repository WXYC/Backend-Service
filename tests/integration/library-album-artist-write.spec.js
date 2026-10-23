const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Integration coverage for the album_artist write path on POST /library and
 * PATCH /library/:id (BS#2004 acceptance criteria, filed as BS#3684).
 *
 * The unit tests mock the service layer, so they cannot see the column, its
 * varchar(128) bound, or the round trip. Stored values are read straight from
 * the table so the assertions do not depend on which read endpoints project
 * the field.
 */
describe('album_artist write path', () => {
  let auth;
  const uniq = Date.now();
  const sql = () => getTestDb();

  const storedAlbumArtist = async (id) => {
    const rows = await sql().unsafe(`SELECT album_artist FROM "${SCHEMA}".library WHERE id = ${Number(id)}`);
    return rows[0].album_artist;
  };

  const countByTitle = async (title) => {
    const rows = await sql().unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}".library WHERE album_title = $1`, [
      title,
    ]);
    return rows[0].n;
  };

  let n = 0;
  const createAlbum = (extra = {}) =>
    auth.post('/library').send({
      album_title: `Album Artist Write ${uniq} ${++n}`,
      artist_name: 'Built to Spill',
      label: `Album Artist Label ${uniq}`,
      genre_id: 11,
      format_id: 1,
      ...extra,
    });

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  describe('POST /library', () => {
    test('stores album_artist and returns it on the response and a re-read', async () => {
      const res = await createAlbum({ album_artist: 'Jessica Pratt' }).expect(201);
      expect(res.body.album_artist).toBe('Jessica Pratt');
      expect(await storedAlbumArtist(res.body.id)).toBe('Jessica Pratt');

      const info = await auth.get('/library/info').query({ album_id: res.body.id }).expect(200);
      expect(info.body.album_artist).toBe('Jessica Pratt');
    });

    test('leaves the column NULL when the field is omitted', async () => {
      const res = await createAlbum().expect(201);
      expect(await storedAlbumArtist(res.body.id)).toBeNull();
    });

    test.each([
      ['trims surrounding whitespace', '  Juana Molina  ', 'Juana Molina'],
      ['stores NULL for an all-whitespace value', '   ', null],
      ['stores NULL for an empty string', '', null],
      ['stores NULL for null', null, null],
      ['accepts exactly 128 characters', 'a'.repeat(128), 'a'.repeat(128)],
    ])('%s', async (_name, input, expected) => {
      const res = await createAlbum({ album_artist: input }).expect(201);
      expect(await storedAlbumArtist(res.body.id)).toBe(expected);
    });

    test('rejects 129 characters with 400 and writes no row', async () => {
      const title = `Album Artist Too Long ${uniq}`;
      const res = await createAlbum({ album_title: title, album_artist: 'a'.repeat(129) }).expect(400);
      expectErrorContains(res, 'album_artist');
      expect(await countByTitle(title)).toBe(0);
    });
  });

  describe('PATCH /library/:id', () => {
    let album;

    beforeEach(async () => {
      const res = await createAlbum({ album_artist: 'Stereolab' }).expect(201);
      album = res.body;
    });

    test.each([
      ['updates an existing value', 'Cat Power', 'Cat Power'],
      ['clears with null', null, null],
      ['trims surrounding whitespace', '  Cat Power  ', 'Cat Power'],
      ['stores NULL for an all-whitespace value', '   ', null],
      ['accepts exactly 128 characters', 'a'.repeat(128), 'a'.repeat(128)],
    ])('%s', async (_name, input, expected) => {
      const res = await auth.patch(`/library/${album.id}`).send({ album_artist: input }).expect(200);
      expect(res.body.album_artist).toBe(expected);
      expect(await storedAlbumArtist(album.id)).toBe(expected);
    });

    test('sets album_artist on an album that had none', async () => {
      const bare = (await createAlbum().expect(201)).body;
      expect(await storedAlbumArtist(bare.id)).toBeNull();

      await auth.patch(`/library/${bare.id}`).send({ album_artist: 'Duke Ellington' }).expect(200);
      expect(await storedAlbumArtist(bare.id)).toBe('Duke Ellington');
    });

    test('leaves the value untouched when the body omits the field', async () => {
      await auth
        .patch(`/library/${album.id}`)
        .send({ album_title: `Album Artist Renamed ${uniq}` })
        .expect(200);
      expect(await storedAlbumArtist(album.id)).toBe('Stereolab');
    });

    test('rejects 129 characters with 400 and leaves the stored value unchanged', async () => {
      const res = await auth
        .patch(`/library/${album.id}`)
        .send({ album_artist: 'a'.repeat(129) })
        .expect(400);
      expectErrorContains(res, 'album_artist');
      expect(await storedAlbumArtist(album.id)).toBe('Stereolab');
    });
  });
});
