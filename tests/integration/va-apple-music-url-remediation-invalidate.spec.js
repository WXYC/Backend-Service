/**
 * Integration tests for the REAL shipped `invalidateAlbumBatch` of
 * `jobs/va-apple-music-url-remediation` — phase 2 of the BS#2000 remediation.
 *
 * WHY THIS RUNS THE REAL FUNCTION. The job shipped with its id list bound as a
 * bare JS array:
 *
 *     WHERE "album_id" = ANY(${albumIds})        // albumIds: number[]
 *
 * Drizzle expands a JS array inside a `sql` template into a comma-separated
 * PARAMETER LIST, so Postgres received `ANY(($1, $2, … $202))` — a row
 * constructor, not an array — and rejected it at parse time (42809,
 * `op ANY/ALL (array) requires array on right side`). Being a parse error, it
 * was dataset-independent: the statement could never have written a row, on any
 * page, for any input. Production reported
 * `album_metadata: {"candidates":206,"invalidated":0,"batches":1}`.
 *
 * A hand-mirrored copy of the statement in this file would NOT have caught
 * that, and would not catch its return: the mirror passes no matter what
 * `orchestrate.ts` actually sends. So this spec `require`s the compiled
 * `dist/orchestrate.cjs` and calls the real exported function — the same
 * arrangement `artist-unicode-dedup-merge.spec.js` uses for `dist/merge.cjs`
 * (BS#1897 review MED-1). Revert the fix and these tests fail.
 *
 * WHY NO EXISTING TEST CAUGHT IT. `jest.unit.config.ts` maps `@wxyc/database`
 * to `tests/mocks/database.mock.ts` and `tests/__mocks__/drizzle-orm.ts` stubs
 * the `sql` tag as `{ sql: strings, values }` — nothing in the unit tier parses
 * SQL, and the suite's `renderSql` helper splices bound values inline, so a
 * mis-parameterized bind is invisible there. Only a real server can reject it.
 *
 * `dist/orchestrate.cjs` is produced by the workspace `build` (tsup dual-format
 * esm+cjs); CI's Build step runs `npm run build` — which covers `jobs/**` —
 * before the integration tier. Rebuild after editing `orchestrate.ts`
 * (`npm run build --workspace=@wxyc/va-apple-music-url-remediation`).
 *
 * The real function uses the `@wxyc/database` `db` singleton (its own pool,
 * DB_* env); this spec seeds and asserts via `getTestDb()`, a separate pool on
 * the same database. All writes commit, so the two pools see each other's rows.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 *
 * @see WXYC/Backend-Service#2000
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock (written for the
// ts-jest unit tier) is AUTOMATICALLY applied to every `drizzle-orm` require —
// no `jest.mock(...)` needed — including here in the integration tier. Our
// compiled `dist/orchestrate.cjs` requires the REAL drizzle-orm (its `sql`
// template builds the UPDATE that `@wxyc/database`'s postgres-js driver runs),
// so unmock it (same pattern as `artist-unicode-dedup-merge.spec.js`). Hoisted
// above the requires below by babel-plugin-jest-hoist.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

// The REAL compiled statement — no reimplementation.
const { invalidateAlbumBatch } = require(
  path.join(__dirname, '..', '..', 'jobs', 'va-apple-music-url-remediation', 'dist', 'orchestrate.cjs')
);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const UPDATE_TIMEOUT_MS = 30_000;

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
    VALUES (
      ${albumId}, 'https://i.discogs.com/x.jpg', ${appleUrl},
      ${appleUrl ? 'verified' : 'unresolved'}, 3, NOW() - INTERVAL '7 days'
    )
  `;
}

async function readRow(sql, albumId) {
  const [row] = await sql`
    SELECT apple_music_url, apple_music_status, streaming_reask_attempts, updated_at
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ${albumId}
  `;
  return row;
}

describe('va-apple-music-url-remediation invalidateAlbumBatch — REAL function (real PG, BS#2000)', () => {
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

  it('REGRESSION: the statement executes and actually invalidates its targets', async () => {
    // This is the test the shipped defect failed: the UPDATE threw 42809 and
    // wrote nothing. Restore `ANY(${albumIds})` and this goes red again.
    const target = await seed('executes');
    const untargeted = await seed('untargeted');

    const written = await invalidateAlbumBatch([{ albumId: target, oldUrl: APPLE_URL }], UPDATE_TIMEOUT_MS);
    expect(written).toBe(1);

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

  it('stamps updated_at — no trigger does it for album_metadata', async () => {
    // Migration 0084's bump_flowsheet_updated_at is flowsheet-only. Without the
    // explicit SET, the freshness signal the BS#1915 sweep and the CDC
    // consumers read would stay frozen at its pre-remediation value (seeded
    // here 7 days in the past).
    const target = await seed('updated-at');
    const before = (await readRow(sql, target)).updated_at;

    await invalidateAlbumBatch([{ albumId: target, oldUrl: APPLE_URL }], UPDATE_TIMEOUT_MS);

    const after = (await readRow(sql, target)).updated_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('COMPARE-AND-SET: a url that changed under us is left alone', async () => {
    // The race this guard closes: between phase 2's page SELECT and this
    // UPDATE, `apps/enrichment-worker/enrich.ts` re-verifies the album through
    // LML's post-#1139 guarded matcher and writes the CORRECT url as
    // 'verified'. Nulling that would open a DJ-visible window through
    // `flowsheet.service.ts`'s coalesce until the BS#1915 sweep re-healed it.
    const target = await seed('cas-changed');
    const REVERIFIED = 'https://music.apple.com/us/song/correct-after-lml-1139/999';
    await sql`
      UPDATE ${sql(SCHEMA)}.album_metadata
         SET apple_music_url = ${REVERIFIED}, apple_music_status = 'verified'
       WHERE album_id = ${target}
    `;

    // We still hold the STALE url we observed at SELECT time.
    const written = await invalidateAlbumBatch([{ albumId: target, oldUrl: APPLE_URL }], UPDATE_TIMEOUT_MS);
    expect(written).toBe(0);

    const row = await readRow(sql, target);
    expect(row.apple_music_url).toBe(REVERIFIED);
    expect(row.apple_music_status).toBe('verified');
    expect(row.streaming_reask_attempts).toBe(3);
  });

  it('COMPARE-AND-SET: a mixed page writes only the rows that still match', async () => {
    const stable = await seed('cas-mixed-stable');
    const raced = await seed('cas-mixed-raced');
    const MOVED = 'https://music.apple.com/us/song/moved/1';
    await sql`
      UPDATE ${sql(SCHEMA)}.album_metadata
         SET apple_music_url = ${MOVED}
       WHERE album_id = ${raced}
    `;

    const written = await invalidateAlbumBatch(
      [
        { albumId: stable, oldUrl: APPLE_URL },
        { albumId: raced, oldUrl: APPLE_URL },
      ],
      UPDATE_TIMEOUT_MS
    );
    expect(written).toBe(1);

    expect((await readRow(sql, stable)).apple_music_url).toBeNull();
    expect((await readRow(sql, raced)).apple_music_url).toBe(MOVED);
  });

  it('carries a full production-width page', async () => {
    // The failing run paged 202 ids at once — the width at which the row
    // constructor became `ANY(($1, $2, … $202))` in the production log.
    const target = await seed('wide-page');
    const filler = Array.from({ length: 201 }, (_, i) => ({ albumId: -1 - i, oldUrl: APPLE_URL }));

    const written = await invalidateAlbumBatch(
      filler.concat([{ albumId: target, oldUrl: APPLE_URL }]),
      UPDATE_TIMEOUT_MS
    );
    expect(written).toBe(1);
    expect((await readRow(sql, target)).apple_music_url).toBeNull();
  });

  it('is a no-op on an empty page', async () => {
    await expect(invalidateAlbumBatch([], UPDATE_TIMEOUT_MS)).resolves.toBe(0);
  });
});
