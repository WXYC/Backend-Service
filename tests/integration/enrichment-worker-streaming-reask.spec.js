/**
 * Integration test for the enrichment worker's bounded self-heal of
 * unresolved streaming links (BS#1915).
 *
 * Pure SQL against the live `album_metadata` table — does NOT import
 * `apps/enrichment-worker/{enrich,streaming-reask}.ts`. Same rationale as
 * every other enrichment-worker integration spec in this directory (see
 * `enrichment-worker-cache-precheck.spec.js` header): the integration
 * runner is babel-jest with no TS support (drizzle-orm + ts-jest
 * incompatibility). `findCandidateAlbumIds` mirrors
 * `streaming-reask.ts#findUnresolvedStreamingCandidates`'s WHERE (the
 * positive form of `precheck.ts`'s negative gate — see that spec's
 * mirror), and `applyReaskVerdict` mirrors `enrich.ts`'s
 * `mergeStreamingField` + `inferIncomingStreamingStatus` + the
 * `upsertMatchedAlbumMetadata` write. When any of those TS functions are
 * hand-edited, the mirrors here must follow.
 *
 * Covers the BS#1915 acceptance criteria end to end against real Postgres:
 *   (a) an `unresolved` field self-heals to `verified` on a later re-ask
 *   (b) an `absent` field is never selected for re-ask again (terminal)
 *   (c) the candidate query + write loop is bounded — no unbounded re-ask
 *   (d) a verified URL is never overwritten, even by a later flapping verdict
 *
 * @see WXYC/Backend-Service#1915
 * @see WXYC/library-metadata-lookup#1053
 * @see WXYC/Backend-Service#1747, #1089
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/** Mirrors `STREAMING_REASK_ATTEMPT_CAP` in `apps/enrichment-worker/enrich.ts`. */
const STREAMING_REASK_ATTEMPT_CAP = 3;

/**
 * Mirrors `enrich.ts#mergeStreamingField` + `#inferIncomingStreamingStatus`.
 * `current` is `{status, url}`; `incoming` is `{status, url}` or undefined
 * (the service's key omitted from this round's verdict — never consulted).
 */
function mergeStreamingField(current, incoming) {
  if (current.status === 'verified') return current;
  const incomingStatus = incoming ? incoming.status || (incoming.url ? 'verified' : undefined) : undefined;
  if (incomingStatus === undefined) return current;
  if (incomingStatus === 'verified') return { status: 'verified', url: incoming.url ?? null };
  // Terminal `absent` is never downgraded by an `unresolved`/`absent` flap
  // (BS#1747/#1089) — only the `verified` above may supersede it.
  if (current.status === 'absent') return current;
  if (incomingStatus === 'absent') return { status: 'absent', url: null };
  return { status: 'unresolved', url: current.url };
}

/**
 * Mirrors `streaming-reask.ts#findUnresolvedStreamingCandidates`'s WHERE —
 * the positive form of `precheck.ts`'s negative gate (see
 * `enrichment-worker-cache-precheck.spec.js`'s mirror for the same
 * COALESCE(..., false) three-valued-logic guard, load-bearing there for the
 * same reason here).
 */
async function findCandidateAlbumIds(sql, albumIds) {
  // Bandcamp re-ask de-freeze (ENRICHMENT_BANDCAMP_REASK) mirror — see
  // `streaming-reask.ts#findUnresolvedStreamingCandidates`. Read at call time
  // so a test can toggle the env var per case; empty fragment (flag off) is a
  // byte-for-byte no-op against every pre-existing assertion in this spec.
  const bandcampFrozenReask =
    process.env.ENRICHMENT_BANDCAMP_REASK === 'true'
      ? sql`OR (bandcamp_status IS NULL AND bandcamp_url LIKE ${'%bandcamp.com/search%'})`
      : sql``;
  const rows = await sql`
    SELECT album_id
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ANY(${albumIds})
       AND (artwork_url IS NOT NULL OR discogs_url IS NOT NULL)
       AND COALESCE(
         streaming_reask_attempts < ${STREAMING_REASK_ATTEMPT_CAP}
         AND (
           spotify_status = 'unresolved'
           OR apple_music_status = 'unresolved'
           OR bandcamp_status = 'unresolved'
           ${bandcampFrozenReask}
         ),
         false
       )
     ORDER BY album_id
  `;
  return rows.map((r) => r.album_id);
}

async function readStreamingState(sql, albumId) {
  const [row] = await sql`
    SELECT spotify_status, spotify_url, apple_music_status, apple_music_url,
           bandcamp_status, bandcamp_url, streaming_reask_attempts
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ${albumId}
  `;
  return row;
}

/**
 * Mirrors `enrich.ts#upsertMatchedAlbumMetadata`'s merge + write for the
 * three streaming fields only (the album-identity columns are out of scope
 * for this spec — `enrichment-worker-cache-precheck.spec.js` already covers
 * the load-bearing artwork/discogs shell distinctions). `verdict` is
 * `{ spotify?: {status, url}, apple_music?: {status, url}, bandcamp?: {status, url} }`
 * — an absent key means that service's key was omitted from this round's
 * LML response (never consulted this round).
 */
async function applyReaskVerdict(sql, albumId, verdict) {
  const prior = await readStreamingState(sql, albumId);
  const spotify = mergeStreamingField({ status: prior.spotify_status, url: prior.spotify_url }, verdict.spotify);
  const appleMusic = mergeStreamingField(
    { status: prior.apple_music_status, url: prior.apple_music_url },
    verdict.apple_music
  );
  const bandcamp = mergeStreamingField({ status: prior.bandcamp_status, url: prior.bandcamp_url }, verdict.bandcamp);

  await sql`
    UPDATE ${sql(SCHEMA)}.album_metadata
       SET spotify_status = ${spotify.status},
           spotify_url = ${spotify.url},
           apple_music_status = ${appleMusic.status},
           apple_music_url = ${appleMusic.url},
           bandcamp_status = ${bandcamp.status},
           bandcamp_url = ${bandcamp.url},
           streaming_reask_attempts = streaming_reask_attempts + 1,
           updated_at = NOW()
     WHERE album_id = ${albumId}
  `;
}

async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'bs1915-reask-test-' + suffix}, 9998, 'Chuquimamani-Condori')
    RETURNING id
  `;
  return rows[0].id;
}

describe('enrichment-worker streaming self-heal — BS#1915 candidate query + write mirror (real PG)', () => {
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

  test('(a) SELF-HEAL: an unresolved apple_music field flips to verified on a later re-ask', async () => {
    const albumId = await insertLibraryAlbum(sql, 'self-heal');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/x.jpg', 'unresolved', 0, NOW())
    `;

    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([albumId]);

    await applyReaskVerdict(sql, albumId, {
      apple_music: { status: 'verified', url: 'https://music.apple.com/album/healed' },
    });

    const row = await readStreamingState(sql, albumId);
    expect(row.apple_music_status).toBe('verified');
    expect(row.apple_music_url).toBe('https://music.apple.com/album/healed');
    expect(row.streaming_reask_attempts).toBe(1);

    // Now resolved — no longer a candidate for a future re-ask.
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([]);
  });

  test('(b) TERMINAL: an absent field is never selected for re-ask again', async () => {
    const albumId = await insertLibraryAlbum(sql, 'absent-terminal');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/x.jpg', 'absent', 0, NOW())
    `;

    // Never a candidate in the first place — 'absent' is terminal from the
    // moment it's written, regardless of attempt count.
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([]);

    const row = await readStreamingState(sql, albumId);
    expect(row.apple_music_status).toBe('absent');
    expect(row.streaming_reask_attempts).toBe(0);
  });

  test('(c) BOUNDED: the candidate query + write loop caps at STREAMING_REASK_ATTEMPT_CAP — no unbounded re-ask', async () => {
    const albumId = await insertLibraryAlbum(sql, 'bounded-cap');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/x.jpg', 'unresolved', 0, NOW())
    `;

    // LML keeps returning "still can't tell" every round — the realistic
    // case a bound has to protect against. Loop more times than the cap
    // allows; each iteration mirrors the production flow: the sweep only
    // re-asks a row the candidate query STILL returns.
    let reaskCount = 0;
    for (let i = 0; i < STREAMING_REASK_ATTEMPT_CAP + 3; i++) {
      const candidates = await findCandidateAlbumIds(sql, [albumId]);
      if (candidates.length === 0) break; // matches production: no candidate, no LML call
      await applyReaskVerdict(sql, albumId, { apple_music: { status: 'unresolved', url: null } });
      reaskCount++;
    }

    expect(reaskCount).toBe(STREAMING_REASK_ATTEMPT_CAP);
    const row = await readStreamingState(sql, albumId);
    expect(row.streaming_reask_attempts).toBe(STREAMING_REASK_ATTEMPT_CAP);
    expect(row.apple_music_status).toBe('unresolved');
    // Past the cap, the row drops out of candidacy — the frozen null is
    // accepted rather than re-asked forever.
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([]);
  });

  test('(d) NEVER OVERWRITE: a verified URL survives a later flapping verdict', async () => {
    const albumId = await insertLibraryAlbum(sql, 'never-overwrite');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, spotify_status, spotify_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/x.jpg', 'verified', 'https://open.spotify.com/album/PRE-EXISTING', 'unresolved', 0, NOW())
    `;

    // Still a candidate — apple_music is the pending field, even though
    // spotify is already verified.
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([albumId]);

    // A flapping response: this round says spotify is 'absent' (would
    // normally null the url out) and apple_music stays unresolved.
    await applyReaskVerdict(sql, albumId, {
      spotify: { status: 'absent', url: null },
      apple_music: { status: 'unresolved', url: null },
    });

    const row = await readStreamingState(sql, albumId);
    // The pre-existing verified URL is untouched — never downgraded.
    expect(row.spotify_status).toBe('verified');
    expect(row.spotify_url).toBe('https://open.spotify.com/album/PRE-EXISTING');
  });

  test('(d cont.) a never-consulted service (key omitted from the verdict) preserves prior state, never invents a verdict', async () => {
    const albumId = await insertLibraryAlbum(sql, 'never-consulted-preserve');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, bandcamp_status, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/x.jpg', 'unresolved', 'unresolved', 0, NOW())
    `;

    // This round's verdict only carries apple_music — bandcamp's key is
    // omitted (never consulted this round).
    await applyReaskVerdict(sql, albumId, {
      apple_music: { status: 'verified', url: 'https://music.apple.com/album/x' },
    });

    const row = await readStreamingState(sql, albumId);
    expect(row.apple_music_status).toBe('verified');
    // bandcamp's prior 'unresolved' is preserved verbatim, not reset.
    expect(row.bandcamp_status).toBe('unresolved');
  });

  test('(e) TERMINAL under sibling heal: a terminal absent field is not resurrected when the row is re-merged to heal an unresolved sibling (BS#1747/#1089)', async () => {
    const albumId = await insertLibraryAlbum(sql, 'absent-survives-sibling-heal');
    insertedAlbumIds.push(albumId);
    // spotify is terminal-absent; apple_music is the pending field that keeps
    // the row a re-ask candidate. The whole row gets re-merged for apple's
    // sake — spotify must not ride along back into 'unresolved'.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, spotify_status, spotify_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/x.jpg', 'absent', NULL, 'unresolved', 0, NOW())
    `;

    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([albumId]);

    // LML's fresh probe this round flaps the already-absent spotify to
    // 'unresolved' while apple heals to verified.
    await applyReaskVerdict(sql, albumId, {
      spotify: { status: 'unresolved', url: null },
      apple_music: { status: 'verified', url: 'https://music.apple.com/album/healed' },
    });

    const row = await readStreamingState(sql, albumId);
    // The terminal absent is preserved — NOT downgraded to unresolved.
    expect(row.spotify_status).toBe('absent');
    expect(row.spotify_url).toBeNull();
    expect(row.apple_music_status).toBe('verified');

    // Row is fully resolved now (apple verified, spotify terminal-absent) —
    // it drops out of candidacy rather than re-asking the resurrected spotify.
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([]);
  });
});

/**
 * Bandcamp re-ask de-freeze (ENRICHMENT_BANDCAMP_REASK) — the candidate query
 * reaches the LEGACY frozen backlog: rows enriched before the write-side
 * coercion went live carry `bandcamp_status = NULL` + a `bandcamp.com/search`
 * fallback URL, which the plain `bandcamp_status = 'unresolved'` disjunct can
 * never match. Real-PG coverage of the gated NULL+search-fallback disjunct
 * added to `findUnresolvedStreamingCandidates` (mirrored above), and of the
 * end-to-end heal to a direct Bandcamp URL on re-ask.
 *
 * @see WXYC/Backend-Service#1747 (the freeze), #1915 (the self-heal sweep)
 */
describe('enrichment-worker streaming self-heal — Bandcamp de-freeze candidate query (real PG)', () => {
  let sql;
  const insertedAlbumIds = [];
  const priorFlag = process.env.ENRICHMENT_BANDCAMP_REASK;

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (priorFlag === undefined) delete process.env.ENRICHMENT_BANDCAMP_REASK;
    else process.env.ENRICHMENT_BANDCAMP_REASK = priorFlag;
    if (insertedAlbumIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
  });

  async function insertFrozenBandcampRow(sql, suffix) {
    const albumId = await insertLibraryAlbum(sql, 'bandcamp-freeze-' + suffix);
    insertedAlbumIds.push(albumId);
    // The exact frozen shape: load-bearing artwork present, bandcamp_status
    // NULL, bandcamp_url the synthesized search fallback.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, bandcamp_url, streaming_reask_attempts, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/x.jpg', 'https://bandcamp.com/search?q=Chuquimamani-Condori%20Edits', 0, NOW())
    `;
    return albumId;
  }

  test('FLAG OFF: a NULL-status search-fallback bandcamp row is NOT a candidate (current behavior preserved)', async () => {
    delete process.env.ENRICHMENT_BANDCAMP_REASK;
    const albumId = await insertFrozenBandcampRow(sql, 'flag-off');
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([]);
  });

  test('FLAG ON: the same frozen bandcamp row becomes a candidate', async () => {
    process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
    const albumId = await insertFrozenBandcampRow(sql, 'flag-on');
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([albumId]);
  });

  test('FLAG ON: an absent bandcamp (also carries a search-fallback url) is NEVER a candidate — terminal', async () => {
    process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
    const albumId = await insertLibraryAlbum(sql, 'bandcamp-absent-terminal');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, bandcamp_status, bandcamp_url, streaming_reask_attempts, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/x.jpg', 'absent', 'https://bandcamp.com/search?q=x', 0, NOW())
    `;
    // The `IS NULL` guard in the gated disjunct excludes an absent row even
    // though its url matches the search-fallback LIKE.
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([]);
  });

  test('FLAG ON: HEAL — a re-ask that resolves a direct bandcamp url flips the row to verified and out of candidacy', async () => {
    process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
    const albumId = await insertFrozenBandcampRow(sql, 'heal');
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([albumId]);

    // LML (now Bandcamp-capable) returns a direct album URL on the re-ask.
    await applyReaskVerdict(sql, albumId, {
      bandcamp: { status: 'verified', url: 'https://chuquimamani.bandcamp.com/album/edits' },
    });

    const row = await readStreamingState(sql, albumId);
    expect(row.bandcamp_status).toBe('verified');
    expect(row.bandcamp_url).toBe('https://chuquimamani.bandcamp.com/album/edits');
    // Resolved — no longer frozen, no longer a candidate.
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([]);
  });

  test('FLAG ON: BOUNDED — a frozen bandcamp that LML still cannot resolve stops at the attempt cap', async () => {
    process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
    const albumId = await insertFrozenBandcampRow(sql, 'bounded');

    let reaskCount = 0;
    for (let i = 0; i < STREAMING_REASK_ATTEMPT_CAP + 3; i++) {
      const candidates = await findCandidateAlbumIds(sql, [albumId]);
      if (candidates.length === 0) break;
      // Mirror the write-side coercion: a match with no bandcamp verdict
      // persists 'unresolved' (retryable) rather than leaving it NULL.
      await applyReaskVerdict(sql, albumId, { bandcamp: { status: 'unresolved', url: null } });
      reaskCount++;
    }

    expect(reaskCount).toBe(STREAMING_REASK_ATTEMPT_CAP);
    const row = await readStreamingState(sql, albumId);
    expect(row.streaming_reask_attempts).toBe(STREAMING_REASK_ATTEMPT_CAP);
    expect(await findCandidateAlbumIds(sql, [albumId])).toEqual([]);
  });
});
