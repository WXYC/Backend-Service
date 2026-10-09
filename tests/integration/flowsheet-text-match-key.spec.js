/**
 * Integration test for `wxyc_schema.text_match_key(text)` (migration 0191, BS#3064, part 1 of BS#3057).
 *
 * The key is the one normalization every flowsheet -> library text-link writer shares: fold_artist_name
 * (NFD, strip combining marks, lowercase), strip a leading "the ", then delete every run outside
 * `[:alnum:]`. Pins the key table and the candidate query the insert path, edit path and
 * scripts/direct-link-flowsheet.sql all run, transcribed as SQL (a later PR pins the Drizzle rendering).
 */

const { getTestDb } = require('../utils/db');
const { seedLibraryRelease, removeSeededLibraryReleases } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

async function key(input) {
  const sql = getTestDb();
  const [row] = await sql`SELECT ${sql(SCHEMA)}.text_match_key(${input}::text) AS k`;
  return row.k;
}

describe('text_match_key', () => {
  test.each([
    ['AFTERLIFE', 'afterlife'],
    ['The Notwist', 'notwist'],
    ['Thee Oh Sees', 'theeohsees'],
    ['坂本龍一', '坂本龍一'],
    ['>>>', ''],
    ['( )', ''],
    ['$', ''],
    ['++++', ''],
    ['?', ''],
    [':)', ''],
    [null, ''],
  ])('%j -> %j', async (input, expected) => {
    expect(await key(input)).toBe(expected);
  });

  test.each([
    ['Nilüfer Yanya NFC/NFD/ASCII', ['Nilüfer Yanya', 'Nilüfer Yanya', 'Nilufer Yanya']],
    ['hyphen vs space', ['Chuquimamani-Condori', 'Chuquimamani Condori']],
    ['slash', ['DJ /rupture', 'DJ Rupture']],
    ['whitespace runs', ['J  Dilla', 'J Dilla ']],
    ['diacritics', ['Hermanos Gutiérrez', 'Hermanos Gutierrez']],
  ])('%s collapse to one key', async (_label, variants) => {
    const keys = await Promise.all(variants.map(key));
    expect(new Set(keys).size).toBe(1);
  });

  test('& and "and" stay distinct', async () => {
    expect(await key('Sun Ra & His Arkestra')).not.toBe(await key('Sun Ra and His Arkestra'));
  });
});

describe('candidate query', () => {
  let a, b, c1, c2, beak;

  beforeAll(async () => {
    a = await seedLibraryRelease({ artist_name: 'Jessica Pratt', album_title: 'Afterlife' });
    b = await seedLibraryRelease({ artist_name: 'Stereolab', album_title: 'Afterlife' });
    c1 = await seedLibraryRelease({ artist_name: 'Chuquimamani-Condori', album_title: 'Edits' });
    c2 = await seedLibraryRelease({ artist_id: c1.artist_id, album_title: 'Edits' });
    beak = await seedLibraryRelease({ artist_name: 'Beak>', album_title: '>>>' });
  });

  afterAll(async () => {
    await removeSeededLibraryReleases();
  });

  async function candidates(artist, album) {
    const sql = getTestDb();
    const k = sql(SCHEMA);
    const rows = await sql`
      SELECT l.id FROM ${k}.library l JOIN ${k}.artists a ON a.id = l.artist_id
      WHERE ${k}.text_match_key(l.album_title) = ${k}.text_match_key(${album}::text)
        AND ${k}.text_match_key(a.artist_name) = ${k}.text_match_key(${artist}::text)
        AND ${k}.text_match_key(${artist}::text) <> ''
        AND ${k}.text_match_key(${album}::text) <> ''
      ORDER BY l.id`;
    return rows.map((r) => r.id);
  }

  test('exact-ish match returns one id', async () => {
    expect(await candidates('Jessica Pratt', 'afterlife')).toEqual([a.id]);
  });

  test('same title under another artist stays separate', async () => {
    expect(await candidates('Stereolab', 'AFTERLIFE')).toEqual([b.id]);
  });

  test('duplicate library rows return both ids', async () => {
    expect(await candidates('Chuquimamani Condori', 'Edits')).toEqual([c1.id, c2.id].sort((x, y) => x - y));
  });

  test('unknown title returns none', async () => {
    expect(await candidates('Jessica Pratt', 'Double Cup')).toEqual([]);
  });

  test('symbols-only title never matches', async () => {
    expect(beak.id).toBeDefined();
    expect(await candidates('Beak>', '>>>')).toEqual([]);
  });
});
