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

/**
 * BS#3145: the guarded `album_metadata` write (`dist/write.cjs`; tsup bundles `artist-keep-sql.ts` into it, so
 * the artist-rule table below runs the real builder). Claims that need a real planner: the backup row and the update commit in one
 * statement or not at all; the race guard; the decision-8 artist rule against stored rows; `clear`; the casts (a
 * non-empty `genres`, a NULL `release_year`); and that no streaming column and no catalog watermark moves.
 */
describe('BS#3145 re-ask album write (REAL statement, real PG)', () => {
  const { writeAlbum } = require(path.join(distDir, 'write.cjs'));

  let sql;
  const albumIds = [];

  const STORED_URL = release(1001);
  const STORED = {
    discogs_url: STORED_URL,
    artwork_url: 'https://i.discogs.com/b3145/stored.jpg',
    release_year: 2013,
    label: 'Crammed Discs',
    full_release_date: '2013-03-12',
    genres: ['Electronic'],
    styles: ['Folktronica'],
    tracklist: [{ position: 'A1', title: 'Wed 21' }],
    discogs_artist_id: 61002,
    artist_bio: 'Argentine singer, songwriter and actress.',
    artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina',
    artist_image_url: 'https://i.discogs.com/b3145/artist.jpg',
    bio_tokens: [{ type: 'text', text: 'Argentine singer' }],
  };
  const STREAMING = {
    spotify_url: 'https://open.spotify.com/album/b3145',
    apple_music_url: 'https://music.apple.com/album/b3145',
    youtube_music_url: null,
    bandcamp_url: 'https://juanamolina.bandcamp.com/album/doga',
    soundcloud_url: null,
    spotify_status: 'verified',
    apple_music_status: 'verified',
    bandcamp_status: 'verified',
    streaming_reask_attempts: 2,
  };
  const RELEASE = {
    discogs_url: release(3003),
    artwork_url: 'https://i.discogs.com/b3145/pin.jpg',
    release_year: null,
    label: 'Sonamos',
    full_release_date: null,
    genres: ['Rock', 'Electronic'],
    styles: ['Experimental', 'Folk'],
    tracklist: [{ position: 'A1', title: 'la paradoja' }],
  };
  const ARTIST = {
    discogs_artist_id: 61002,
    artist_bio: null,
    artist_wikipedia_url: null,
    artist_image_url: null,
    bio_tokens: null,
  };
  const COLUMNS = Object.keys(STORED);

  /** A card with a fully enriched `album_metadata` row; returns the cohort row the write takes. */
  const seed = async (suffix, metadata = {}) => {
    const [{ id, legacy_release_id }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (1, 11, 1, ${'b3145-write-' + suffix}, 9999, 'Juana Molina')
      RETURNING id, legacy_release_id
    `;
    albumIds.push(id);
    const row = { album_id: id, ...STORED, ...STREAMING, ...metadata };
    const json = (value) => (value === null ? null : sql.json(value));
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        ${sql({ ...row, tracklist: json(row.tracklist), bio_tokens: json(row.bio_tokens) })}
    `;
    return {
      album_id: id,
      legacy_release_id,
      discogs_url: row.discogs_url,
      artwork_url: row.artwork_url,
      library_artwork_url: null,
      stored_release_id: 1001,
      artist_name: 'Juana Molina',
      album_title: 'b3145-write-' + suffix,
      reason: 'pin_mismatch',
      pin_release_id: 3003,
      pin_source: MASTERS_API,
    };
  };

  const rebind = (artist = ARTIST) => ({ kind: 'rebind', release_id: 3003, payload: { release: RELEASE, artist } });
  const clear = () => ({ kind: 'clear', payload: { release: nulls(Object.keys(RELEASE)), artist: null } });
  const nulls = (keys) => Object.fromEntries(keys.map((k) => [k, null]));
  const write = (row, verdict, over = {}) =>
    writeAlbum({ run_id: 'b3145-run', pin_export_sha256: 'abc123', row, tier: 'rebind', verdict, ...over });

  const stored = async (id) => {
    const [row] = await sql`SELECT * FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ${id}`;
    return row;
  };
  const backups = (id) =>
    sql`SELECT * FROM ${sql(SCHEMA)}.album_metadata_reask_backup WHERE album_id = ${id} ORDER BY id`;
  const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (albumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata_reask_backup WHERE album_id = ANY(${albumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${albumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${albumIds})`;
    }
  });

  test('a rebind writes the release group and its backup row together, and nothing else', async () => {
    const row = await seed('rebind');
    // Seeded after the library insert, whose own trigger bumps it; the trigger writes GREATEST(now(), last).
    await sql`UPDATE ${sql(SCHEMA)}.library_watermark SET last_modified_at = '2000-01-01T00:00:00Z'`;

    expect(await write(row, rebind())).toEqual({ written: true, artist_cleared: false });

    const after = await stored(row.album_id);
    // Same artist id: the null bio, links and tokens in the answer keep the stored ones (decision 8).
    expect(pick(after, COLUMNS)).toEqual({ ...RELEASE, ...pick(STORED, Object.keys(ARTIST)) });
    expect(pick(after, Object.keys(STREAMING))).toEqual(STREAMING);

    const [backup, ...rest] = await backups(row.album_id);
    expect(rest).toEqual([]);
    expect(backup).toMatchObject({
      run_id: 'b3145-run',
      target_table: 'album_metadata',
      row_id: row.album_id,
      before_image: STORED,
      after_image: pick(after, COLUMNS),
      provenance: {
        reason: 'pin_mismatch',
        verdict: 'rebind',
        tier: 'rebind',
        legacy_release_id: row.legacy_release_id,
        pin_release_id: 3003,
        pin_source: MASTERS_API,
        pin_export_sha256: 'abc123',
        prior_release_id: 1001,
        new_release_id: 3003,
      },
    });
    // The restore's "changed since" guard.
    expect(backup.written_at).toEqual(after.updated_at);

    const [{ last_modified_at }] = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
    expect(last_modified_at.toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  test('writes nothing when the stored release moved since enumeration', async () => {
    const row = await seed('raced', { discogs_url: release(5005) });
    const before = await stored(row.album_id);

    expect(await write({ ...row, discogs_url: STORED_URL }, rebind())).toEqual({ written: false });

    expect(await stored(row.album_id)).toEqual(before);
    expect(await backups(row.album_id)).toEqual([]);
  });

  test('writes nothing when the backup row cannot be written', async () => {
    const row = await seed('no-backup');
    const before = await stored(row.album_id);

    // `run_id` is NOT NULL: the backup insert fails, and so does the whole statement.
    await expect(write(row, rebind(), { run_id: null })).rejects.toThrow();

    expect(await stored(row.album_id)).toEqual(before);
    expect(await backups(row.album_id)).toEqual([]);
  });

  test.each([
    // [label, stored artist id, answered artist id, answered bio, the bio written, artist_cleared]
    ['both ids set and equal, no bio answered: kept', 61002, 61002, null, STORED.artist_bio, false],
    ['both ids set and equal, a bio answered: the answer', 61002, 61002, 'Sonamos founder.', 'Sonamos founder.', false],
    ['both ids set and different: written as answered', 61002, 77, null, null, true],
    ['stored id null: written as answered', null, 61002, null, null, true],
    ['answered id null: written as answered', 61002, null, null, null, true],
    ['both ids null: written as answered', null, null, null, null, true],
  ])('artist rule: %s', async (_label, storedId, answeredId, answeredBio, bio, cleared) => {
    const row = await seed('artist-' + albumIds.length, { discogs_artist_id: storedId });
    const answer = { ...ARTIST, discogs_artist_id: answeredId, artist_bio: answeredBio };

    expect(await write(row, rebind(answer))).toEqual({ written: true, artist_cleared: cleared });

    const after = await stored(row.album_id);
    expect(after.discogs_artist_id).toBe(answeredId);
    expect(after.artist_bio).toBe(bio);
    // The other artist columns, null in every answer here, follow the rule's arm.
    const kept = storedId !== null && storedId === answeredId;
    expect(after.artist_wikipedia_url).toBe(kept ? STORED.artist_wikipedia_url : null);
    expect(after.bio_tokens).toEqual(kept ? STORED.bio_tokens : null);
  });

  test('clear nulls the release group, keeps the artist group, and images both', async () => {
    const row = await seed('clear');

    expect(await write({ ...row, reason: 'pin_removed', pin_release_id: null }, clear())).toEqual({
      written: true,
      artist_cleared: false,
    });

    const after = await stored(row.album_id);
    expect(pick(after, COLUMNS)).toEqual({ ...nulls(Object.keys(RELEASE)), ...pick(STORED, Object.keys(ARTIST)) });
    expect(pick(after, Object.keys(STREAMING))).toEqual(STREAMING);
    const [backup] = await backups(row.album_id);
    expect(backup.before_image).toEqual(STORED);
    expect(backup.after_image).toEqual(pick(after, COLUMNS));
    expect(backup.provenance).toMatchObject({ reason: 'pin_removed', verdict: 'clear', new_release_id: null });
  });
});

/**
 * BS#3146: the catalog cover pass (`dist/catalog-pass.cjs`), after real album writes (`dist/write.cjs`). Claims that
 * need real rows: only a catalog cover that mirrors the old stored cover is rewritten, with its `library` backup row;
 * a librarian's cover and an album touched since its write are left alone; the catalog watermark moves when the pass
 * writes (the positive control for the album write's "unchanged"), and not at all when the probe is empty, so a
 * second pass sends nothing.
 */
describe('BS#3146 re-ask catalog cover pass (REAL statements, real PG)', () => {
  const { writeAlbum } = require(path.join(distDir, 'write.cjs'));
  const { runCatalogPass } = require(path.join(distDir, 'catalog-pass.cjs'));

  const RUN = 'b3146-run';
  const OLD = 'https://i.discogs.com/b3146/wrong-release.jpg';
  const NEW = 'https://i.discogs.com/b3146/pinned-release.jpg';
  const LIBRARIAN = 'https://i.discogs.com/b3146/librarian.jpg';
  const NULLS = {
    release_year: null,
    label: null,
    full_release_date: null,
    genres: null,
    styles: null,
    tracklist: null,
  };
  const ARTIST = {
    discogs_artist_id: null,
    artist_bio: null,
    artist_wikipedia_url: null,
    artist_image_url: null,
    bio_tokens: null,
  };

  let sql;
  const albumIds = [];

  /** A card whose `album_metadata` row stores the wrong release's cover, and its write by this run. */
  const seedAndWrite = async ({ artist, title, catalogCover, newCover, touched }) => {
    const [{ id, legacy_release_id }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name, artwork_url)
      VALUES (1, 11, 1, ${'b3146-' + title}, 9999, ${artist}, ${catalogCover})
      RETURNING id, legacy_release_id
    `;
    albumIds.push(id);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, discogs_url, artwork_url)
      VALUES (${id}, ${release(1001)}, ${OLD})
    `;
    const row = {
      album_id: id,
      legacy_release_id,
      discogs_url: release(1001),
      artwork_url: OLD,
      library_artwork_url: catalogCover,
      stored_release_id: 1001,
      artist_name: artist,
      album_title: title,
      reason: 'pin_mismatch',
      pin_release_id: 3003,
      pin_source: MASTERS_API,
    };
    const payload = { release: { ...NULLS, discogs_url: release(3003), artwork_url: newCover }, artist: ARTIST };
    const verdict = { kind: 'rebind', release_id: 3003, payload };
    expect(await writeAlbum({ run_id: RUN, pin_export_sha256: 'abc123', row, tier: 'rebind', verdict })).toEqual({
      written: true,
      artist_cleared: false,
    });
    if (touched) {
      // Another writer after the re-ask: `updated_at` no longer equals the backup's `written_at`.
      await sql`UPDATE ${sql(SCHEMA)}.album_metadata SET updated_at = updated_at + interval '1 second' WHERE album_id = ${id}`;
    }
    return id;
  };

  const catalogCover = async (id) => {
    const [{ artwork_url }] = await sql`SELECT artwork_url FROM ${sql(SCHEMA)}.library WHERE id = ${id}`;
    return artwork_url;
  };
  const libraryBackups = (id) =>
    sql`SELECT * FROM ${sql(SCHEMA)}.album_metadata_reask_backup WHERE album_id = ${id} AND target_table = 'library'`;
  const resetWatermark = () =>
    sql`UPDATE ${sql(SCHEMA)}.library_watermark SET last_modified_at = '2000-01-01T00:00:00Z'`;
  const watermark = async () => {
    const [{ last_modified_at }] = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
    return last_modified_at.toISOString();
  };

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (albumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata_reask_backup WHERE album_id = ANY(${albumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${albumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${albumIds})`;
    }
  });

  test('rewrites only mirroring covers, backs each up, and moves the catalog watermark; a second pass is a no-op', async () => {
    const CASES = [
      // [label, seed, the catalog cover after the pass]
      ['a mirroring cover', { artist: 'Juana Molina', title: 'DOGA', catalogCover: OLD, newCover: NEW }, NEW],
      [
        'a mirroring cover whose new release has none',
        { artist: 'Stereolab', title: 'Dots and Loops', catalogCover: OLD, newCover: null },
        null,
      ],
      [
        "a librarian's cover",
        { artist: 'Jessica Pratt', title: 'On Your Own Love Again', catalogCover: LIBRARIAN, newCover: NEW },
        LIBRARIAN,
      ],
      ['no catalog cover', { artist: 'Jessica Pratt', title: 'Quiet Signs', catalogCover: null, newCover: NEW }, null],
      [
        'an album touched since its write',
        { artist: 'Stereolab', title: 'Emperor Tomato Ketchup', catalogCover: OLD, newCover: NEW, touched: true },
        OLD,
      ],
    ];
    const ids = [];
    for (const [, seed] of CASES) ids.push(await seedAndWrite(seed));
    await resetWatermark();

    expect(await runCatalogPass(RUN)).toEqual({ album_writes: 5, probed: 2, rewritten: 2, analyze_error: null });

    for (const [i, [label, seed, expected]] of CASES.entries()) {
      expect([label, await catalogCover(ids[i])]).toEqual([label, expected]);
      const backups = await libraryBackups(ids[i]);
      expect([label, backups.length]).toEqual([label, expected === seed.catalogCover ? 0 : 1]);
    }
    const [backup] = await libraryBackups(ids[0]);
    const [albumBackup] = await sql`
      SELECT provenance FROM ${sql(SCHEMA)}.album_metadata_reask_backup WHERE album_id = ${ids[0]} AND target_table = 'album_metadata'
    `;
    expect(backup).toMatchObject({
      run_id: RUN,
      row_id: ids[0],
      before_image: { artwork_url: OLD },
      after_image: { artwork_url: NEW },
      provenance: albumBackup.provenance,
    });
    // The positive control for the album write's "watermark unchanged": moved, by the pass's one statement (its
    // transaction's NOW()). The unit suite pins that the pass sends exactly one write.
    expect(await watermark()).toBe(backup.written_at.toISOString());

    await resetWatermark();
    expect(await runCatalogPass(RUN)).toEqual({ album_writes: 5, probed: 0, rewritten: 0, analyze_error: null });
    expect(await watermark()).toBe('2000-01-01T00:00:00.000Z');
    expect(await libraryBackups(ids[0])).toHaveLength(1);
  });

  test('sends nothing for a run with no album writes, so the catalog watermark stays put', async () => {
    await resetWatermark();

    expect(await runCatalogPass('b3146-no-such-run')).toEqual({
      album_writes: 0,
      probed: 0,
      rewritten: 0,
      analyze_error: null,
    });

    expect(await watermark()).toBe('2000-01-01T00:00:00.000Z');
  });
});
