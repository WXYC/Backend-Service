/**
 * Integration test for the atomic CASE-based streaming UPSERT (BS#1923 +
 * BS#1924), replacing the old read-then-merge-then-write flow in
 * `apps/enrichment-worker/enrich.ts#upsertMatchedAlbumMetadata`.
 *
 * BS#1945: this spec imports and runs the REAL
 * `buildStreamingFieldConflictSet` (BS#1923) — extracted to the
 * side-effect-free `apps/enrichment-worker/streaming-merge-sql.ts` precisely
 * so a plain `.spec.js` integration test can `require` its compiled
 * `dist/streaming-merge-sql.cjs` (dual esm+cjs tsup entry, same recipe as
 * `jobs/artist-unicode-dedup/merge.ts` / `tests/integration/
 * artist-unicode-dedup-merge.spec.js`) and exercise the GENUINE CASE
 * expressions against a real row — no hand-duplicated SQL mirror left to
 * drift when `buildStreamingFieldConflictSet` is edited. Before this,
 * `fieldConflictSql` here was a hand-written copy of that function; a
 * hand-edit of the real one without a matching edit here left this spec
 * green against stale SQL. The unit suite,
 * `tests/unit/apps/enrichment-worker/enrich.test.ts`, separately pins
 * `buildStreamingFieldConflictSet`'s exact `.sql`/`.values` text; this spec
 * pins the *runtime behavior* those CASEs produce against real Postgres,
 * including the race #1923 closes.
 *
 * The BS#1924 `streaming_reask_attempts` gate is NOT part of that
 * extraction (it is an inline CASE inside `upsertMatchedAlbumMetadata`,
 * never its own named/exported function) and stays a hand-mirrored literal
 * below — kept byte-identical to `enrich.ts`'s SET expression. Its logic is
 * a single three-column CASE (tiny, low drift risk) versus
 * `buildStreamingFieldConflictSet`'s four-branch-times-three-field surface,
 * which is where BS#1945 scopes the fix.
 *
 * BS#1923 (TOCTOU): the old flow read the album's prior streaming state via
 * a separate SELECT *before* the LML round-trip, then wrote the merge
 * verdict computed against that now-stale snapshot. A live CDC verify
 * landing during the round-trip could get silently clobbered. The fix folds
 * the merge into the UPDATE itself as CASE expressions over the LIVE
 * columns, so there is no separate read to go stale — whatever the row
 * holds AT THE MOMENT this statement executes is what the CASE sees, no
 * matter how a JS-side verdict (computed independently, from LML, with no
 * knowledge of concurrent writes) says to merge it.
 *
 * Test (a) simulates the race directly: a concurrent write lands (mimicking
 * a live CDC verify landing during the sweep's LML round-trip) BEFORE the
 * atomic conflict-update statement executes, carrying a verdict that would
 * downgrade the field if it were being merged against a stale snapshot. The
 * verified state must survive — proving the CASE evaluates the row as it
 * stands at execution time, not an earlier read.
 *
 * BS#1924 (re-ask counter miscount): the shared `streaming_reask_attempts`
 * counter must increment only on a GENUINE re-ask of an album that already
 * carried a load-bearing match (`artwork_url` OR `discogs_url` present)
 * BEFORE this write — never on a BS#1089 no-match shell row's first real
 * match, even though that write also hits the same UPDATE (the row already
 * existed as a shell). Tests (b)/(c) cover both sides of that gate.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker
 * tier) plus a built `@wxyc/enrichment-worker` (`dist/streaming-merge-
 * sql.cjs`) and a built `@wxyc/database` (`dist/`) — CI's Build step
 * (`npm run build`) produces both before the integration tier runs.
 *
 * @see WXYC/Backend-Service#1923
 * @see WXYC/Backend-Service#1924
 * @see WXYC/Backend-Service#1915 (the self-heal mechanism these two harden)
 * @see WXYC/Backend-Service#1089 (the no-match shell row BS#1924 protects)
 * @see WXYC/Backend-Service#1945 (this spec's mirror-drift fix)
 */

// `@wxyc/database` -> `drizzle-orm`, and the compiled `streaming-merge-sql.cjs`
// below also requires the real `drizzle-orm` for its `sql` tag. The repo-wide
// `tests/__mocks__/drizzle-orm.ts` manual mock (written for the ts-jest unit
// config, see jest.unit.config.ts) is a Jest node_modules manual mock, which
// Jest substitutes automatically for ANY test file that requires
// `drizzle-orm` — no `jest.mock(...)` call needed to trigger it — including
// this babel-jest-transformed integration spec, where that `.ts` mock file
// fails to parse (no TypeScript-stripping transform is registered for
// `jest.config.json`). `jest.unmock` opts this file back into the real
// `drizzle-orm` package so `@wxyc/database`'s real postgres-js driver and the
// real `buildStreamingFieldConflictSet` CASE-building both run for real —
// hoisted above the requires below by babel-plugin-jest-hoist (same
// convention as `artist-unicode-dedup-merge.spec.js` /
// `catalog-popularity-freetext-resolve-enumerate.spec.js`).
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');
const { db, album_metadata, closeDatabaseConnection } = require('@wxyc/database');
const { sql, eq, and } = require('drizzle-orm');

// The REAL `buildStreamingFieldConflictSet` (BS#1923), compiled by the
// workspace `build` (tsup dual-format esm+cjs); CI's Build step runs before
// the integration tier. Rebuild after editing `streaming-merge-sql.ts`
// (`npm run build --workspace=@wxyc/enrichment-worker`).
const streamingMergeSql = require(
  path.join(__dirname, '..', '..', 'apps', 'enrichment-worker', 'dist', 'streaming-merge-sql.cjs')
);
const { buildStreamingFieldConflictSet, NO_FALLBACK } = streamingMergeSql;

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Runs ONE atomic UPDATE against `album_metadata`, mirroring the `set`
 * clause of `enrich.ts#upsertMatchedAlbumMetadata`'s `onConflictDoUpdate`
 * (BS#1923 + BS#1924) closely enough to exercise both fixes:
 *   - The three streaming fields (spotify/apple_music/bandcamp) use the REAL
 *     `buildStreamingFieldConflictSet` — no reimplementation (BS#1945).
 *   - `streaming_reask_attempts` stays a hand-mirrored CASE (see header) —
 *     it reads `artwork_url`/`discogs_url` as they stood BEFORE this same
 *     statement's writes, exactly like every other `set` expression in a
 *     drizzle `.update(...).set(...)` (or an `ON CONFLICT DO UPDATE`) —
 *     evaluated by Postgres against the pre-statement row.
 *
 * A plain UPDATE (not `db.insert(...).onConflictDoUpdate(...)`) because
 * every test here pre-seeds the row via raw SQL, so production's write
 * always takes the conflict branch — which behaves identically to this
 * UPDATE against the already-existing row.
 */
async function atomicConflictUpdate(albumId, { artworkUrl, discogsUrl, verdict, searchUrls }) {
  const spotify = buildStreamingFieldConflictSet(
    album_metadata.spotify_status,
    album_metadata.spotify_url,
    verdict.spotify?.status,
    verdict.spotify?.url ?? null,
    searchUrls.spotify_url
  );
  const appleMusic = buildStreamingFieldConflictSet(
    album_metadata.apple_music_status,
    album_metadata.apple_music_url,
    verdict.apple_music?.status,
    verdict.apple_music?.url ?? null,
    NO_FALLBACK
  );
  const bandcamp = buildStreamingFieldConflictSet(
    album_metadata.bandcamp_status,
    album_metadata.bandcamp_url,
    verdict.bandcamp?.status,
    verdict.bandcamp?.url ?? null,
    searchUrls.bandcamp_url
  );

  await db
    .update(album_metadata)
    .set({
      artwork_url: artworkUrl,
      discogs_url: discogsUrl,
      spotify_status: spotify.status,
      spotify_url: spotify.url,
      apple_music_status: appleMusic.status,
      apple_music_url: appleMusic.url,
      bandcamp_status: bandcamp.status,
      bandcamp_url: bandcamp.url,
      streaming_reask_attempts: sql`CASE
        WHEN ${album_metadata.artwork_url} IS NOT NULL OR ${album_metadata.discogs_url} IS NOT NULL
        THEN ${album_metadata.streaming_reask_attempts} + 1
        ELSE ${album_metadata.streaming_reask_attempts}
      END`,
      updated_at: sql`NOW()`,
    })
    .where(and(eq(album_metadata.album_id, albumId), sql`${album_metadata.updated_at} < NOW()`));
}

async function readRow(sql, albumId) {
  const [row] = await sql`
    SELECT artwork_url, discogs_url,
           spotify_status, spotify_url,
           apple_music_status, apple_music_url,
           bandcamp_status, bandcamp_url,
           streaming_reask_attempts
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ${albumId}
  `;
  return row;
}

async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'bs1923-1924-toctou-test-' + suffix}, 9997, 'Chuquimamani-Condori')
    RETURNING id
  `;
  return rows[0].id;
}

describe('enrichment-worker streaming UPSERT — atomic CASE merge (BS#1923) + re-ask counter gate (BS#1924), real PG', () => {
  let sql;
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
    // `@wxyc/database` opens the shared postgres-js pool as a side effect of
    // import (shared/database/src/client.ts's module-level
    // `createPostgresClient()`). That pool is separate from this spec's own
    // `sql` client above (`getTestDb()`), so it needs its own teardown or the
    // process has an open handle after the suite finishes.
    await closeDatabaseConnection();
  });

  test('(a) TOCTOU CLOSED: a concurrent verify landing before the atomic write executes survives a flapping re-ask verdict', async () => {
    const albumId = await insertLibraryAlbum(sql, 'toctou-race');
    insertedAlbumIds.push(albumId);
    // Starting state: spotify is 'unresolved' — the state a hypothetical
    // stale read (the old code's SELECT, taken before the LML round-trip)
    // would have captured.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, discogs_url, spotify_status, streaming_reask_attempts, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/x.jpg', 'https://discogs.com/release/1', 'unresolved', 0, NOW())
    `;

    // A live CDC verify lands NOW — mimicking it landing during the sweep's
    // LML round-trip, i.e. AFTER a stale read would have already captured
    // 'unresolved', but BEFORE the atomic write below executes.
    await sql`
      UPDATE ${sql(SCHEMA)}.album_metadata
         SET spotify_status = 'verified', spotify_url = 'https://open.spotify.com/album/CONCURRENTLY-VERIFIED', updated_at = NOW()
       WHERE album_id = ${albumId}
    `;

    // The atomic write's own JS-side verdict — LML's fresh probe flapping
    // spotify to 'absent', unaware of the concurrent verify. Under the OLD
    // read-then-merge-then-write flow this would have clobbered the
    // just-verified row (the merge would have run against the STALE
    // 'unresolved' snapshot). The atomic CASE evaluates the row as it
    // stands right now instead.
    await atomicConflictUpdate(albumId, {
      artworkUrl: 'https://i.discogs.com/x.jpg',
      discogsUrl: 'https://discogs.com/release/1',
      verdict: { spotify: { status: 'absent', url: null } },
      searchUrls: { spotify_url: 'https://open.spotify.com/search/should-not-be-used', bandcamp_url: null },
    });

    const row = await readRow(sql, albumId);
    expect(row.spotify_status).toBe('verified');
    expect(row.spotify_url).toBe('https://open.spotify.com/album/CONCURRENTLY-VERIFIED');
  });

  test('(b) COUNTER GATE: a no-match shell album resolving its first REAL match leaves streaming_reask_attempts at 0', async () => {
    const albumId = await insertLibraryAlbum(sql, 'shell-to-matched');
    insertedAlbumIds.push(albumId);
    // A BS#1089 no-match shell: search-URLs only, artwork_url/discogs_url
    // both still NULL. This row already exists, so the write below hits
    // the UPDATE (conflict) branch even though it is this album's first
    // REAL match.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, spotify_url, streaming_reask_attempts, updated_at)
      VALUES
        (${albumId}, 'https://open.spotify.com/search/shell-fallback', 0, NOW())
    `;

    await atomicConflictUpdate(albumId, {
      artworkUrl: 'https://i.discogs.com/first-real-match.jpg',
      discogsUrl: 'https://discogs.com/release/2',
      verdict: { spotify: { status: 'verified', url: 'https://open.spotify.com/album/real' } },
      searchUrls: { spotify_url: 'https://open.spotify.com/search/fallback', bandcamp_url: null },
    });

    const row = await readRow(sql, albumId);
    expect(row.artwork_url).toBe('https://i.discogs.com/first-real-match.jpg');
    expect(row.spotify_status).toBe('verified');
    // The load-bearing point: the counter is gated on the PRE-update
    // artwork_url/discogs_url (both NULL going into this statement), so the
    // shell's first real match does NOT miscount as a re-ask.
    expect(row.streaming_reask_attempts).toBe(0);
  });

  test('(c) COUNTER GATE: a genuine re-ask of an already-matched album DOES increment the counter', async () => {
    const albumId = await insertLibraryAlbum(sql, 'already-matched-reask');
    insertedAlbumIds.push(albumId);
    // Already carries a load-bearing match from a prior enrichment.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, discogs_url, spotify_status, streaming_reask_attempts, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/existing.jpg', 'https://discogs.com/release/3', 'unresolved', 0, NOW())
    `;

    await atomicConflictUpdate(albumId, {
      artworkUrl: 'https://i.discogs.com/existing.jpg',
      discogsUrl: 'https://discogs.com/release/3',
      verdict: { spotify: { status: 'unresolved', url: null } },
      searchUrls: { spotify_url: 'https://open.spotify.com/search/fallback', bandcamp_url: null },
    });

    const row = await readRow(sql, albumId);
    expect(row.streaming_reask_attempts).toBe(1);

    // A SECOND genuine re-ask increments again — not a one-time fluke.
    await atomicConflictUpdate(albumId, {
      artworkUrl: 'https://i.discogs.com/existing.jpg',
      discogsUrl: 'https://discogs.com/release/3',
      verdict: { spotify: { status: 'unresolved', url: null } },
      searchUrls: { spotify_url: 'https://open.spotify.com/search/fallback', bandcamp_url: null },
    });
    const row2 = await readRow(sql, albumId);
    expect(row2.streaming_reask_attempts).toBe(2);
  });

  test('(d) never downgrades a verified field even on a genuinely fresh (non-racy) absent re-ask — same CASE, no concurrency involved', async () => {
    const albumId = await insertLibraryAlbum(sql, 'verified-no-race-control');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, discogs_url, spotify_status, spotify_url, streaming_reask_attempts, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/x.jpg', 'https://discogs.com/release/4', 'verified', 'https://open.spotify.com/album/ALREADY-VERIFIED', 0, NOW())
    `;

    await atomicConflictUpdate(albumId, {
      artworkUrl: 'https://i.discogs.com/x.jpg',
      discogsUrl: 'https://discogs.com/release/4',
      verdict: { spotify: { status: 'absent', url: null } },
      searchUrls: { spotify_url: 'https://open.spotify.com/search/should-not-be-used', bandcamp_url: null },
    });

    const row = await readRow(sql, albumId);
    expect(row.spotify_status).toBe('verified');
    expect(row.spotify_url).toBe('https://open.spotify.com/album/ALREADY-VERIFIED');
  });
});
