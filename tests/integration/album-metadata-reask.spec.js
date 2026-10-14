/**
 * BS#3137 album_metadata re-ask: the cohort enumeration (BS#3142) against the live `album_metadata` and `library`
 * tables.
 *
 * Runs the REAL compiled statements (`jobs/album-metadata-reask/dist/cohort.cjs`) through `@wxyc/database`'s
 * postgres-js driver, the `album-metadata-bio-fill.spec.js` pattern. The unit suite mocks `drizzle-orm`, so there a
 * statement is only text; these are the claims that need a real planner:
 *
 *   1. The pins and the removals, bound as `intArrayLiteral` strings cast to `int[]`, join through
 *      `library.legacy_release_id`, never `library.id`.
 *   2. `pin_mismatch` and `pin_removed` admit exactly the rows the plan describes, and the counts name each source
 *      and each exclusion.
 *   3. The enumeration honours the cursor, the carried list and the cap, in `album_id` order.
 *
 * `dist/cohort.cjs` is produced by the workspace build (tsup esm+cjs); CI's Build step runs before the integration
 * tier. Rebuild after editing `cohort.ts` (`npm run build --workspace=@wxyc/album-metadata-reask`).
 *
 * @see WXYC/Backend-Service#3142
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock is auto-applied to every `drizzle-orm` require. The
// compiled bundle needs the real one. Hoisted above the requires by babel-plugin-jest-hoist.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const distDir = path.join(__dirname, '..', '..', 'jobs', 'album-metadata-reask', 'dist');
const { countCohort, enumerateCohort } = require(path.join(distDir, 'cohort.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const MASTERS_API = 'alex-l-2026-masters-api';
const ALEX = 'alex-l-2026';
const release = (id) => `https://www.discogs.com/release/${id}-Juana-Molina-DOGA`;

describe('BS#3142 re-ask cohort (REAL statements, real PG)', () => {
  let sql;
  const albumIds = [];

  /**
   * A library card plus its `album_metadata` row. Returns the album id and the minted card id, which is what a pin
   * names. `library.artist_name` differs from the fixture artist's own name, so the COALESCE order is observable.
   */
  const seed = async (suffix, metadata = {}, library = {}) => {
    const lib = { artist_name: 'Juana Molina (library)', discogs_unavailable: false, artwork_url: null, ...library };
    const [{ id, legacy_release_id }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (artist_id, genre_id, format_id, album_title, code_number, artist_name, discogs_unavailable, artwork_url)
      VALUES
        (1, 11, 1, ${'b3142-reask-' + suffix}, 9999, ${lib.artist_name}, ${lib.discogs_unavailable}, ${lib.artwork_url})
      RETURNING id, legacy_release_id
    `;
    albumIds.push(id);
    const row = { discogs_url: release(1001), artwork_url: 'https://i.discogs.com/b3142/stored.jpg', ...metadata };
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, discogs_url, artwork_url)
      VALUES (${id}, ${row.discogs_url}, ${row.artwork_url})
    `;
    return { id, card: legacy_release_id };
  };

  const pin = (card, discogs_release_id, source = MASTERS_API) => ({ library_id: card, discogs_release_id, source });

  /** This spec's own rows out of the enumeration, which reads the whole table. */
  const enumerateOwn = async (inputs, options = {}) =>
    (await enumerateCohort(inputs, { limit: 0, afterAlbumId: 0, ...options })).filter((c) =>
      albumIds.includes(c.album_id)
    );

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

  test('enumerates a pin mismatch and a removed pin with every column the later slices need', async () => {
    const mismatch = await seed('mismatch', {}, { artwork_url: 'https://i.discogs.com/b3142/stored.jpg' });
    const removed = await seed('removed', { discogs_url: release(2002), artwork_url: null }, { artist_name: null });
    const [{ artist_name: fixtureArtist }] = await sql`SELECT artist_name FROM ${sql(SCHEMA)}.artists WHERE id = 1`;

    const rows = await enumerateOwn({
      pins: [pin(mismatch.card, 3003)],
      removed: [pin(removed.card, 2002, ALEX)],
    });

    expect(rows).toEqual([
      {
        album_id: mismatch.id,
        legacy_release_id: mismatch.card,
        discogs_url: release(1001),
        artwork_url: 'https://i.discogs.com/b3142/stored.jpg',
        library_artwork_url: 'https://i.discogs.com/b3142/stored.jpg',
        stored_release_id: 1001,
        artist_name: 'Juana Molina (library)',
        album_title: 'b3142-reask-mismatch',
        reason: 'pin_mismatch',
        pin_release_id: 3003,
        pin_source: MASTERS_API,
      },
      {
        album_id: removed.id,
        legacy_release_id: removed.card,
        discogs_url: release(2002),
        artwork_url: null,
        library_artwork_url: null,
        stored_release_id: 2002,
        artist_name: fixtureArtist,
        album_title: 'b3142-reask-removed',
        reason: 'pin_removed',
        pin_release_id: null,
        pin_source: ALEX,
      },
    ]);
  });

  test('joins through legacy_release_id: a pin keyed by library.id matches nothing', async () => {
    const card = await seed('id-space');

    expect(await enumerateOwn({ pins: [pin(card.id, 3003)], removed: [] })).toEqual([]);
  });

  test.each([
    ['a row that already stores the pin', { discogs_url: release(3003) }, {}, 'pin', []],
    ["the '' synthetic-match sentinel", { discogs_url: '' }, {}, 'pin', []],
    ['a row with no Discogs URL', { discogs_url: null }, {}, 'pin', []],
    ['an album marked not on Discogs', {}, { discogs_unavailable: true }, 'pin', []],
    ['a removed card whose row stores some other release', { discogs_url: release(4004) }, {}, 'removed', []],
    // A card pinned again is judged against its new pin only, never as a removal.
    ['a removed card that has been pinned again', { discogs_url: release(2002) }, {}, 'both', ['pin_mismatch']],
  ])('%s', async (_label, metadata, library, kind, reasons) => {
    const { id, card } = await seed('out-' + albumIds.length, metadata, library);
    const inputs = {
      pins: kind === 'removed' ? [] : [pin(card, 3003)],
      removed: kind === 'pin' ? [] : [pin(card, 2002)],
    };

    const own = (await enumerateOwn(inputs)).filter((c) => c.album_id === id);

    expect(own.map((c) => c.reason)).toEqual(reasons);
  });

  test.each([
    ['a master URL', 'https://www.discogs.com/master/77'],
    // Past `int`: would have aborted the whole read as `out of range`; a prefix of it must not be read as an id.
    ['an id too large for int', 'https://www.discogs.com/release/123456789012345678901-X'],
  ])('treats %s as an unparseable mismatch, without failing the read', async (label, url) => {
    const { id, card } = await seed('unparseable-' + albumIds.length, { discogs_url: url });

    const [row] = await enumerateOwn({ pins: [pin(card, 123456789)], removed: [] });

    expect(row).toMatchObject({ album_id: id, stored_release_id: null, reason: 'pin_mismatch' });
  });

  test('binds a source holding quotes, a comma and a backslash as one value', async () => {
    const awkward = 'manual "fix", C:\\pins';
    const { card } = await seed('awkward-source');

    const [row] = await enumerateOwn({ pins: [pin(card, 3003, awkward)], removed: [] });

    expect(row.pin_source).toBe(awkward);
  });

  test('honours the cursor, the carried list and the cap, in album_id order', async () => {
    const a = await seed('order-a');
    const b = await seed('order-b');
    const c = await seed('order-c');
    const inputs = { pins: [a, b, c].map((s) => pin(s.card, 3003)), removed: [] };
    const ids = async (options) => (await enumerateOwn(inputs, options)).map((r) => r.album_id);

    expect(await ids({ afterAlbumId: a.id })).toEqual([b.id, c.id]);
    expect(await ids({ albumIds: [c.id, a.id] })).toEqual([a.id, c.id]);
    expect(await ids({ afterAlbumId: b.id, albumIds: [a.id] })).toEqual([a.id, c.id]);
    expect(await ids({ limit: 1, afterAlbumId: a.id - 1 })).toEqual([a.id]);
  });

  test('counts by reason and source, with every exclusion by cause', async () => {
    const mismatch = await seed('count-mismatch', {}, { artwork_url: 'https://i.discogs.com/b3142/stored.jpg' });
    // `library.artist_id` and `artists.artist_name` are both NOT NULL, so the no-artist exclusion cannot be seeded
    // here; it is a guard against a future schema, pinned by the unit suite.
    const second = await seed('count-second');
    const unavailable = await seed('count-unavailable', {}, { discogs_unavailable: true });
    const removed = await seed('count-removed', { discogs_url: release(2002) });
    const other = await seed('count-other', { discogs_url: release(4004) });

    const counts = await countCohort({
      pins: [pin(mismatch.card, 3003), pin(second.card, 3003, ALEX), pin(unavailable.card, 3003, ALEX)],
      removed: [pin(removed.card, 2002), pin(other.card, 2002, ALEX)],
    });

    // Exact: the pins name only this test's cards, so no other row in the table can enter the count.
    const byKey = (x, y) => `${x.reason}/${x.source}`.localeCompare(`${y.reason}/${y.source}`);
    expect([...counts.by_reason_and_source].sort(byKey)).toEqual([
      { reason: 'pin_mismatch', source: ALEX, n: 2 },
      { reason: 'pin_mismatch', source: MASTERS_API, n: 1 },
      { reason: 'pin_removed', source: MASTERS_API, n: 1 },
    ]);
    expect(counts).toMatchObject({
      total: 4,
      eligible: 3,
      excluded: { no_artist_name: 0, discogs_unavailable: 1, removed_stores_other: 1 },
      catalog_cover_mirrors: 1,
    });
  });

  test('takes a whole pin export as one bound array', async () => {
    const { id, card } = await seed('large');
    // Thousands of other cards' pins, as the real export has, around the one that matters.
    const filler = Array.from({ length: 5000 }, (_, i) => pin(1_900_000_000 + i, 1 + i));

    const rows = await enumerateOwn({ pins: [...filler, pin(card, 3003)], removed: [] });

    expect(rows.map((r) => r.album_id)).toEqual([id]);
  });
});
