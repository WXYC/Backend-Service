/**
 * Integration test for BS#2000's `album_metadata` invalidation UPDATE — the
 * statement `invalidateAlbumBatch` (orchestrate.ts) sends for every page of
 * phase 2.
 *
 * WHY THIS EXISTS. The job shipped with the id list bound as a bare JS array:
 *
 *     WHERE "album_id" = ANY(${albumIds})        // albumIds: number[]
 *
 * Drizzle expands a JS array inside a `sql` template into a comma-separated
 * PARAMETER LIST, so Postgres received `ANY(($1, $2, … $202))` — a row
 * constructor, not an array. `ANY` requires an array, so the statement failed on
 * every page and the phase reported `{"candidates":206,"invalidated":0}`. The
 * repo idiom (the BS#1068/BS#1071 trap, documented in
 * `jobs/album-critic-reviews-etl/antijoin.ts`) is to bind a `{1,2,3}`
 * array-literal STRING with an explicit `::int[]` cast.
 *
 * WHY NO EXISTING TEST CAUGHT IT. `jest.unit.config.ts` maps `@wxyc/database`
 * to `tests/mocks/database.mock.ts` and `tests/__mocks__/drizzle-orm.ts` stubs
 * the `sql` tag as `{ sql: strings, values }` — nothing parses SQL, and the
 * suite's `renderSql` helper splices bound values inline, so the two bindings
 * are indistinguishable there. Only a real server can reject the bad one.
 *
 * Pure SQL — does NOT import the TS job. Same constraint as the sibling
 * `va-apple-music-url-remediation-net.spec.js` (read its header): the
 * integration runner is babel-jest with no TypeScript support. `UPDATE_SET` and
 * `UPDATE_TAIL` below mirror `invalidateAlbumBatch`; when that function is
 * hand-edited, the SQL here must follow.
 *
 * `sql.unsafe` rather than a postgres-js tagged template on purpose: postgres-js
 * binds a JS array as a genuine PG array and would paper over the very
 * distinction under test. The text here is what the driver actually receives.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 *
 * @see WXYC/Backend-Service#2000
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/** Mirrors `invalidateAlbumBatch`'s SET clause in orchestrate.ts. */
const UPDATE_SET = `
  UPDATE "${SCHEMA}"."album_metadata"
  SET "apple_music_url" = NULL,
      "apple_music_status" = 'unresolved',
      "streaming_reask_attempts" = 0,
      "updated_at" = NOW()
`;

/** Mirrors the guard that keeps a concurrent write from being clobbered. */
const UPDATE_TAIL = `AND "apple_music_url" IS NOT NULL`;

/** The FIXED predicate: one param, a PG array literal, explicitly cast. */
const arrayLiteralStatement = () => `${UPDATE_SET} WHERE "album_id" = ANY($1::int[]) ${UPDATE_TAIL}`;

/** The SHIPPED predicate: what drizzle emits for a bare `number[]`. */
const rowConstructorStatement = (count) => {
  const placeholders = Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ');
  return `${UPDATE_SET} WHERE "album_id" = ANY((${placeholders})) ${UPDATE_TAIL}`;
};

/** Mirrors `intArrayLiteral` in the sibling jobs (ghost-row-sweep, metadata-backfill). */
const intArrayLiteral = (ids) => `{${ids.join(',')}}`;

const APPLE_URL = 'https://music.apple.com/us/song/bs2000-invalidate-fixture/777';

async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'bs2000-invalidate-' + suffix}, 9997, 'Various Artists')
    RETURNING id
  `;
  return rows[0].id;
}

async function insertAlbumMetadata(sql, albumId, appleUrl) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.album_metadata
      (album_id, artwork_url, apple_music_url, apple_music_status, streaming_reask_attempts, updated_at)
    VALUES (${albumId}, 'https://i.discogs.com/x.jpg', ${appleUrl}, ${appleUrl ? 'verified' : 'unresolved'}, 3, NOW())
  `;
}

async function readRow(sql, albumId) {
  const [row] = await sql`
    SELECT apple_music_url, apple_music_status, streaming_reask_attempts
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ${albumId}
  `;
  return row;
}

describe('BS#2000 album_metadata invalidation UPDATE (real Postgres)', () => {
  let sql;
  const insertedAlbumIds = [];

  const seed = async (suffix, appleUrl = APPLE_URL) => {
    const albumId = await insertLibraryAlbum(sql, suffix);
    insertedAlbumIds.push(albumId);
    await insertAlbumMetadata(sql, albumId, appleUrl);
    return albumId;
  };

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
  });

  it('REGRESSION: the row-constructor predicate is rejected outright by Postgres', async () => {
    const target = await seed('row-constructor');

    // Parse-time failure (make_scalar_array_op), so it is dataset-independent:
    // the shipped statement could never have invalidated a row, on any page,
    // for any input. That is the whole content of the production log line
    // `album_metadata: {"candidates":206,"invalidated":0,"batches":1}`.
    await expect(sql.unsafe(rowConstructorStatement(2), [target, target + 1])).rejects.toMatchObject({
      code: '42809',
    });

    // …and the row it was supposed to clean is untouched.
    const row = await readRow(sql, target);
    expect(row.apple_music_url).toBe(APPLE_URL);
    expect(row.streaming_reask_attempts).toBe(3);
  });

  it('the array-literal predicate invalidates exactly the targeted rows', async () => {
    const target = await seed('literal-target');
    const untargeted = await seed('literal-untargeted');

    const result = await sql.unsafe(arrayLiteralStatement(), [intArrayLiteral([target])]);
    expect(result.count).toBe(1);

    // Handed to the BS#1915 hourly re-ask sweep: url cleared, status flipped to
    // 'unresolved', and the exhausted attempt budget reset so the sweep will
    // actually pick the row up.
    const cleaned = await readRow(sql, target);
    expect(cleaned.apple_music_url).toBeNull();
    expect(cleaned.apple_music_status).toBe('unresolved');
    expect(cleaned.streaming_reask_attempts).toBe(0);

    const spared = await readRow(sql, untargeted);
    expect(spared.apple_music_url).toBe(APPLE_URL);
    expect(spared.apple_music_status).toBe('verified');
    expect(spared.streaming_reask_attempts).toBe(3);
  });

  it('the IS NOT NULL guard skips an already-null row inside the id list', async () => {
    const alreadyNull = await seed('literal-already-null', null);
    const withUrl = await seed('literal-with-url');

    const result = await sql.unsafe(arrayLiteralStatement(), [intArrayLiteral([alreadyNull, withUrl])]);
    // Both ids are in the list; only the one carrying a URL is written.
    expect(result.count).toBe(1);

    const untouched = await readRow(sql, alreadyNull);
    expect(untouched.streaming_reask_attempts).toBe(3);
  });

  it('the array literal carries a full production-width page', async () => {
    const target = await seed('literal-wide-page');

    // The failing run paged 202 ids at once — the width at which the row
    // constructor became `ANY(($1, $2, … $202))` in the production log.
    const ids = Array.from({ length: 201 }, (_, i) => -1 - i).concat(target);
    const result = await sql.unsafe(arrayLiteralStatement(), [intArrayLiteral(ids)]);
    expect(result.count).toBe(1);
    expect((await readRow(sql, target)).apple_music_url).toBeNull();
  });
});
