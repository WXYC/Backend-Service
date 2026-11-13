/**
 * BS#1442 extended fill — the fill-null write against the live `album_metadata` table.
 *
 * Runs the REAL compiled `fillAlbum` and its UPDATE
 * (`jobs/album-metadata-extended-fill/dist/fill.cjs`) through `@wxyc/database`'s
 * postgres-js driver, with LML replaced by a stub fetcher. What needs a real
 * PostgreSQL:
 *
 *   1. tracklist and bio_tokens round-trip as JSON, genres and styles as arrays.
 *   2. A column something else wrote first survives (COALESCE, never overwrite).
 *   3. bio_tokens are never written beside a NULL bio.
 *   4. A row whose discogs_url moved after the cohort read is not written
 *      (`release_changed`).
 *   5. A second run changes nothing, and updated_at is never touched.
 *   6. A pin that disagrees with the stored release means no write.
 *   7. The artist columns are not filled beside a different stored artist id.
 *
 * Rebuild after editing the job (`npm run build --workspace=@wxyc/album-metadata-extended-fill`).
 *
 * @see WXYC/Backend-Service#1442
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock is auto-applied
// to every `drizzle-orm` require. The compiled bundle needs the real one.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const distDir = path.join(__dirname, '..', '..', 'jobs', 'album-metadata-extended-fill', 'dist');
const { fillAlbum, NO_PRIOR_NOT_FOUND } = require(path.join(distDir, 'fill.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const RELEASE_URL = 'https://www.discogs.com/release/1442-Juana-Molina-DOGA';
const COLUMNS = [
  'tracklist',
  'genres',
  'styles',
  'label',
  'full_release_date',
  'discogs_artist_id',
  'artist_image_url',
  'bio_tokens',
];

const RELEASE = {
  release_id: 1442,
  artist_id: 82730,
  artists: [{ artist_id: 82730, name: 'Juana Molina', join: '' }],
  label: 'Sonamos',
  released: '2024-05-10',
  genres: ['Electronic', 'Folk, World, & Country'],
  styles: ['Experimental', 'with "quotes" and \\ backslash'],
  tracklist: [{ position: 'A1', title: 'la paradoja', duration: '4:01', artists: [] }],
  cached: true,
};
const ARTIST = {
  artist_id: 82730,
  name: 'Juana Molina',
  image_url: 'https://i.discogs.com/a/82730.jpg',
  profile_tokens: [{ type: 'plainText', text: 'Argentine singer.' }],
};

const stubLml = () => ({
  release: jest.fn(() => Promise.resolve({ ok: true, value: RELEASE })),
  artist: jest.fn(() => Promise.resolve({ ok: true, value: ARTIST })),
  pins: jest.fn(() => Promise.resolve({ ok: true, value: [] })),
  calls: () => 0,
});

describe('BS#1442 extended fill write (REAL statements, real PG)', () => {
  let sql;
  const albumIds = [];

  const seed = async (suffix, metadata = {}) => {
    const [{ id }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (1, 11, 1, ${'b1442-extended-write-' + suffix}, 9999)
      RETURNING id
    `;
    albumIds.push(id);
    const row = { discogs_url: RELEASE_URL, artist_bio: 'Argentine singer.', ...metadata };
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, discogs_url, artist_bio, label, discogs_artist_id, updated_at)
      VALUES (${id}, ${row.discogs_url}, ${row.artist_bio}, ${row.label ?? null},
              ${row.discogs_artist_id ?? null}, '2026-01-01T00:00:00Z')
    `;
    return id;
  };

  /** The candidate the cohort would have returned for a freshly seeded row. */
  const candidate = (album_id, overrides = {}) => ({
    album_id,
    discogs_url: RELEASE_URL,
    has_bio: true,
    has_wikipedia_url: false,
    missing: [...COLUMNS],
    legacy_release_id: null,
    ...overrides,
  });

  const read = async (id) => {
    const [row] = await sql`
      SELECT tracklist, genres, styles, label, full_release_date, discogs_artist_id,
             artist_image_url, bio_tokens, updated_at
        FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${id}
    `;
    return row;
  };

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

  test('fills all eight columns: jsonb round-trips as JSON, genres and styles as text arrays', async () => {
    const id = await seed('round-trip');

    const result = await fillAlbum(candidate(id), stubLml(), undefined, NO_PRIOR_NOT_FOUND);

    expect(result).toMatchObject({ outcome: 'filled', carried: false, filled: COLUMNS });
    expect(await read(id)).toMatchObject({
      tracklist: RELEASE.tracklist,
      genres: RELEASE.genres,
      styles: RELEASE.styles,
      label: 'Sonamos',
      full_release_date: '2024-05-10',
      discogs_artist_id: 82730,
      artist_image_url: ARTIST.image_url,
      bio_tokens: ARTIST.profile_tokens,
    });
  });

  test('a value written first survives: each column fills only where NULL', async () => {
    const id = await seed('worker-wrote', { label: 'Crammed Discs' });

    await fillAlbum(candidate(id), stubLml(), undefined, NO_PRIOR_NOT_FOUND);

    expect((await read(id)).label).toBe('Crammed Discs');
  });

  test('writes no bio_tokens beside a NULL bio, whatever the cohort snapshot said', async () => {
    const id = await seed('no-bio', { artist_bio: null });

    await fillAlbum(candidate(id), stubLml(), undefined, NO_PRIOR_NOT_FOUND);

    const row = await read(id);
    expect(row.bio_tokens).toBeNull();
    expect(row.artist_image_url).toBe(ARTIST.image_url);
  });

  test('a discogs_url that moved after the cohort read -> release_changed, nothing written', async () => {
    const id = await seed('moved', { discogs_url: 'https://www.discogs.com/release/530321' });

    const result = await fillAlbum(candidate(id), stubLml(), undefined, NO_PRIOR_NOT_FOUND);

    expect(result).toMatchObject({ outcome: 'release_changed', carried: false });
    expect(await read(id)).toMatchObject({ tracklist: null, label: null, discogs_artist_id: null });
  });

  test('never touches updated_at, and a second run over the filled row changes nothing', async () => {
    const id = await seed('rerun');
    await fillAlbum(candidate(id), stubLml(), undefined, NO_PRIOR_NOT_FOUND);
    const first = await read(id);

    const other = { ...RELEASE, label: 'Other Label', genres: ['Jazz'], tracklist: [{ position: 'B1', title: 'x' }] };
    const lml = stubLml();
    lml.release.mockResolvedValue({ ok: true, value: other });
    await fillAlbum(candidate(id), lml, undefined, NO_PRIOR_NOT_FOUND);

    const second = await read(id);
    expect(second).toEqual(first);
    expect(second.updated_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('a pin that names another release -> pin_disagrees, no release fetch, no write', async () => {
    const id = await seed('pin-disagrees');
    const lml = stubLml();
    const pin = { ok: true, pin: { discogs_release_id: 530321, source: 'alex-2026-10', in_cache: true, tracks: [] } };

    const result = await fillAlbum(candidate(id), lml, pin, NO_PRIOR_NOT_FOUND);

    expect(result.outcome).toBe('pin_disagrees');
    expect(lml.release).not.toHaveBeenCalled();
    expect(await read(id)).toMatchObject({ tracklist: null, label: null, discogs_artist_id: null });
  });

  test('leaves the artist columns NULL beside a different stored artist id', async () => {
    const id = await seed('other-artist', { discogs_artist_id: 99 });

    const result = await fillAlbum(candidate(id), stubLml(), undefined, NO_PRIOR_NOT_FOUND);

    // Reported as the UPDATE left the row, not as the fetch suggested.
    expect(result.outcome).toBe('filled');
    expect(result.filled).not.toContain('artist_image_url');
    expect(result.filled).not.toContain('bio_tokens');
    expect(await read(id)).toMatchObject({
      discogs_artist_id: 99,
      artist_image_url: null,
      bio_tokens: null,
      label: 'Sonamos',
    });
  });
});
