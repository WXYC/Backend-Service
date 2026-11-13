/**
 * BS#1442 extended fill — the cohort statements against the live
 * `album_metadata` table.
 *
 * Runs the REAL compiled statements (`jobs/album-metadata-extended-fill/dist/cohort.cjs`)
 * through `@wxyc/database`'s postgres-js driver, the `album-metadata-bio-fill.spec.js`
 * pattern. The unit suite only sees the SQL as text; these are the claims that
 * need a real planner:
 *
 *   1. The predicate takes a row whose `discogs_url` names a release and which
 *      still lacks a fillable column, and leaves out master URLs, the `''`
 *      synthetic sentinel, NULL URLs, complete rows, and rows whose only gap is
 *      `bio_tokens` beside a NULL bio.
 *   2. The enumeration returns the stored URL, the bio flags and the missing
 *      columns as a real array, and honours the cursor, the cap and the list.
 *   3. The stats count the cohort and each column's gap.
 *
 * `dist/cohort.cjs` is produced by the workspace build; rebuild after editing
 * `cohort.ts` (`npm run build --workspace=@wxyc/album-metadata-extended-fill`).
 *
 * @see WXYC/Backend-Service#1442
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock is auto-applied
// to every `drizzle-orm` require. The compiled bundle needs the real one.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const distDir = path.join(__dirname, '..', '..', 'jobs', 'album-metadata-extended-fill', 'dist');
const { cohortStats, enumerateCohort } = require(path.join(distDir, 'cohort.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const RELEASE_URL = 'https://www.discogs.com/release/1442-Juana-Molina-DOGA';

/** Every extended column filled: a row with nothing left to add. */
const COMPLETE = {
  tracklist: [{ position: 'A1', title: 'la paradoja' }],
  genres: ['Electronic'],
  styles: ['Experimental'],
  label: 'Sonamos',
  full_release_date: '2024-05-10',
  discogs_artist_id: 82730,
  artist_image_url: 'https://i.discogs.com/a/82730.jpg',
  bio_tokens: [{ type: 'plainText', text: 'Argentine singer.' }],
};

describe('BS#1442 extended fill cohort (REAL statements, real PG)', () => {
  let sql;
  const albumIds = [];

  /** A library album plus its `album_metadata` row; extended columns NULL unless given. */
  const seed = async (suffix, metadata = {}) => {
    const [{ id }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (1, 11, 1, ${'b1442-extended-fill-' + suffix}, 9999)
      RETURNING id
    `;
    albumIds.push(id);
    const row = { discogs_url: RELEASE_URL, artist_bio: 'Argentine singer.', artist_wikipedia_url: null, ...metadata };
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, discogs_url, artist_bio, artist_wikipedia_url, tracklist, genres, styles, label,
         full_release_date, discogs_artist_id, artist_image_url, bio_tokens)
      VALUES
        (${id}, ${row.discogs_url}, ${row.artist_bio}, ${row.artist_wikipedia_url},
         ${row.tracklist ? sql.json(row.tracklist) : null}, ${row.genres ?? null}, ${row.styles ?? null},
         ${row.label ?? null}, ${row.full_release_date ?? null}, ${row.discogs_artist_id ?? null},
         ${row.artist_image_url ?? null}, ${row.bio_tokens ? sql.json(row.bio_tokens) : null})
    `;
    return id;
  };

  const enumerateOwn = async (options = {}) =>
    (await enumerateCohort({ limit: 0, afterAlbumId: 0, ...options })).filter((c) => albumIds.includes(c.album_id));

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (albumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${albumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${albumIds})`;
    }
    // The pool is shared with the rest of the integration suite; do NOT close it.
  });

  test('returns a row with a release URL and NULL columns, with its URL, bio flags and missing columns', async () => {
    const id = await seed('all-null', { artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina' });

    const [candidate] = (await enumerateOwn()).filter((c) => c.album_id === id);

    expect(candidate).toEqual({
      album_id: id,
      discogs_url: RELEASE_URL,
      has_bio: true,
      has_wikipedia_url: true,
      missing: [
        'tracklist',
        'genres',
        'styles',
        'label',
        'full_release_date',
        'discogs_artist_id',
        'artist_image_url',
        'bio_tokens',
      ],
      legacy_release_id: expect.any(Number),
    });
  });

  test("returns the row's library.legacy_release_id, the id space LML's pins are keyed in, not library.id", async () => {
    const id = await seed('legacy-id');
    await sql`UPDATE ${sql(SCHEMA)}.library SET legacy_release_id = 2147000001 WHERE id = ${id}`;

    const [candidate] = (await enumerateOwn()).filter((c) => c.album_id === id);

    expect(candidate.legacy_release_id).toBe(2147000001);
  });

  test('lists only the columns still missing, and leaves bio_tokens out beside a NULL bio', async () => {
    const { tracklist: _t, bio_tokens: _b, ...rest } = COMPLETE;
    const id = await seed('partial', { ...rest, artist_bio: null });

    const [candidate] = (await enumerateOwn()).filter((c) => c.album_id === id);

    expect(candidate).toMatchObject({ has_bio: false, missing: ['tracklist'] });
  });

  test.each([
    ['a master URL', { discogs_url: 'https://www.discogs.com/master/1442' }],
    ["the '' synthetic sentinel", { discogs_url: '' }],
    ['a NULL discogs_url', { discogs_url: null }],
    ['a /release/0 URL', { discogs_url: 'https://www.discogs.com/release/0' }],
    ['a release id past int4', { discogs_url: 'https://www.discogs.com/release/21474836480' }],
    ['a complete row', COMPLETE],
    ['a row whose only gap is bio_tokens beside a NULL bio', { ...COMPLETE, bio_tokens: undefined, artist_bio: null }],
  ])('skips %s', async (_label, metadata) => {
    const id = await seed('skipped-' + albumIds.length, metadata);

    expect((await enumerateOwn()).map((c) => c.album_id)).not.toContain(id);
  });

  test('skips an album a music director marked as not on Discogs (BS#1294), whatever release URL it still stores', async () => {
    const id = await seed('discogs-unavailable');
    await sql`UPDATE ${sql(SCHEMA)}.library SET discogs_unavailable = true WHERE id = ${id}`;

    expect((await enumerateOwn()).map((c) => c.album_id)).not.toContain(id);
  });

  test('takes a complete row missing only bio_tokens when it has a bio', async () => {
    const id = await seed('tokens-only', { ...COMPLETE, bio_tokens: undefined });

    const [candidate] = (await enumerateOwn()).filter((c) => c.album_id === id);

    expect(candidate.missing).toEqual(['bio_tokens']);
  });

  test('honours the cursor and the cap, in album_id order', async () => {
    const first = await seed('cursor-a');
    const second = await seed('cursor-b');

    const afterFirst = (await enumerateOwn({ afterAlbumId: first })).map((c) => c.album_id);
    expect(afterFirst).not.toContain(first);
    expect(afterFirst).toContain(second);

    const capped = await enumerateCohort({ limit: 1, afterAlbumId: first - 1 });
    expect(capped.map((c) => c.album_id)).toEqual([first]);
  });

  test('a list with no cursor is only those ids; with a cursor, those ids plus everything above it', async () => {
    const carried = await seed('list-carried');
    const between = await seed('list-between');
    const cursor = await seed('list-cursor');
    const above = await seed('list-above');
    const complete = await seed('list-complete', COMPLETE);

    const retry = await enumerateCohort({ limit: 0, afterAlbumId: 0, albumIds: [above, carried, complete] });
    expect(retry.map((c) => c.album_id)).toEqual([carried, above]);

    const carriedRun = await enumerateCohort({ limit: 2, afterAlbumId: cursor, albumIds: [carried] });
    expect(carriedRun.map((c) => c.album_id)).toEqual([carried, above]);
    expect(carriedRun.map((c) => c.album_id)).not.toContain(between);
  });

  test('stats count the cohort and each column gap', async () => {
    const before = await cohortStats();
    await seed('stats-all-null');
    await seed('stats-no-bio', { ...COMPLETE, tracklist: undefined, bio_tokens: undefined, artist_bio: null });
    await seed('stats-complete', COMPLETE);

    const after = await cohortStats();

    expect(after.cohort - before.cohort).toBe(2);
    expect(after.tracklist - before.tracklist).toBe(2);
    expect(after.label - before.label).toBe(1);
    expect(after.bio_tokens - before.bio_tokens).toBe(1);
  });
});
