/**
 * Integration test for the atomic CASE-based streaming UPSERT (BS#1923 +
 * BS#1924), replacing the old read-then-merge-then-write flow in
 * `apps/enrichment-worker/enrich.ts#upsertMatchedAlbumMetadata`.
 *
 * Pure SQL against the live `album_metadata` table — does NOT import
 * `apps/enrichment-worker/enrich.ts`. Same rationale as every other
 * enrichment-worker integration spec in this directory (see
 * `enrichment-worker-cache-precheck.spec.js` / `enrichment-worker-streaming-
 * reask.spec.js` headers): the integration runner is babel-jest with no TS
 * support (drizzle-orm + ts-jest incompatibility). `fieldConflictSql` mirrors
 * `enrich.ts#buildStreamingFieldConflictSet` field-for-field — when that
 * function is hand-edited, this mirror must follow (the unit suite,
 * `tests/unit/apps/enrichment-worker/enrich.test.ts`, pins its exact CASE
 * text/values against the real module; this spec pins the *behavior* those
 * CASEs produce against a real row, including the race #1923 closes).
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
 * @see WXYC/Backend-Service#1923
 * @see WXYC/Backend-Service#1924
 * @see WXYC/Backend-Service#1915 (the self-heal mechanism these two harden)
 * @see WXYC/Backend-Service#1089 (the no-match shell row BS#1924 protects)
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Mirrors `enrich.ts#buildStreamingFieldConflictSet` for ONE streaming
 * field. `incoming` is `{status, url}` or undefined (the service's key was
 * omitted from this round's LML verdict — never consulted this round).
 * `fallbackUrl` is the synthesized search-URL fallback for a field that has
 * one (spotify/bandcamp), or `null` for Apple Music (BS#1192, no fallback).
 * Returns `{status, url}` postgres.js SQL fragments built from the LIVE
 * `statusCol`/`urlCol` — nested directly into the caller's UPDATE (postgres.js
 * "Building queries" — `${ sql`` }` for sql fragments), never a JS value
 * computed from a prior SELECT.
 */
function fieldConflictSql(sql, statusCol, urlCol, incoming, fallbackUrl) {
  const incomingStatus = incoming ? incoming.status : undefined;
  const incomingUrl = incoming ? (incoming.url ?? null) : null;
  const hasFallback = fallbackUrl !== null;

  if (incomingStatus === undefined) {
    return {
      status: sql`${sql(statusCol)}`,
      url: hasFallback
        ? sql`CASE WHEN ${sql(statusCol)} = 'verified' THEN ${sql(urlCol)} ELSE ${fallbackUrl} END`
        : sql`${sql(urlCol)}`,
    };
  }
  if (incomingStatus === 'verified') {
    return {
      status: sql`'verified'`,
      url: sql`CASE WHEN ${sql(statusCol)} = 'verified' THEN ${sql(urlCol)} ELSE ${incomingUrl} END`,
    };
  }
  if (incomingStatus === 'absent') {
    return {
      status: sql`CASE WHEN ${sql(statusCol)} = 'verified' THEN ${sql(statusCol)} ELSE 'absent' END`,
      url: sql`CASE WHEN ${sql(statusCol)} = 'verified' THEN ${sql(urlCol)} ELSE ${fallbackUrl} END`,
    };
  }
  // incomingStatus === 'unresolved'
  return {
    status: sql`CASE WHEN ${sql(statusCol)} = 'verified' OR ${sql(statusCol)} = 'absent' THEN ${sql(statusCol)} ELSE 'unresolved' END`,
    url: hasFallback
      ? sql`CASE WHEN ${sql(statusCol)} = 'verified' THEN ${sql(urlCol)} ELSE ${fallbackUrl} END`
      : sql`${sql(urlCol)}`,
  };
}

/**
 * Mirrors the `onConflictDoUpdate` `set` clause of
 * `enrich.ts#upsertMatchedAlbumMetadata` (BS#1923 + BS#1924) as ONE atomic
 * UPDATE: the three streaming fields' CASEs (BS#1923) plus the
 * `streaming_reask_attempts` gate (BS#1924), which reads `artwork_url`/
 * `discogs_url` as they stood BEFORE this same statement's writes — Postgres
 * evaluates every `SET` expression in an UPDATE against the pre-statement
 * row, exactly like every other `set` expression here.
 */
async function atomicConflictUpdate(sql, albumId, { artworkUrl, discogsUrl, verdict, searchUrls }) {
  const spotify = fieldConflictSql(sql, 'spotify_status', 'spotify_url', verdict.spotify, searchUrls.spotify_url);
  const appleMusic = fieldConflictSql(sql, 'apple_music_status', 'apple_music_url', verdict.apple_music, null);
  const bandcamp = fieldConflictSql(sql, 'bandcamp_status', 'bandcamp_url', verdict.bandcamp, searchUrls.bandcamp_url);

  await sql`
    UPDATE ${sql(SCHEMA)}.album_metadata
       SET artwork_url = ${artworkUrl},
           discogs_url = ${discogsUrl},
           spotify_status = ${spotify.status},
           spotify_url = ${spotify.url},
           apple_music_status = ${appleMusic.status},
           apple_music_url = ${appleMusic.url},
           bandcamp_status = ${bandcamp.status},
           bandcamp_url = ${bandcamp.url},
           streaming_reask_attempts = CASE
             WHEN artwork_url IS NOT NULL OR discogs_url IS NOT NULL
             THEN streaming_reask_attempts + 1
             ELSE streaming_reask_attempts
           END,
           updated_at = NOW()
     WHERE album_id = ${albumId}
       AND updated_at < NOW()
  `;
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
    await atomicConflictUpdate(sql, albumId, {
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

    await atomicConflictUpdate(sql, albumId, {
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

    await atomicConflictUpdate(sql, albumId, {
      artworkUrl: 'https://i.discogs.com/existing.jpg',
      discogsUrl: 'https://discogs.com/release/3',
      verdict: { spotify: { status: 'unresolved', url: null } },
      searchUrls: { spotify_url: 'https://open.spotify.com/search/fallback', bandcamp_url: null },
    });

    const row = await readRow(sql, albumId);
    expect(row.streaming_reask_attempts).toBe(1);

    // A SECOND genuine re-ask increments again — not a one-time fluke.
    await atomicConflictUpdate(sql, albumId, {
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

    await atomicConflictUpdate(sql, albumId, {
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
