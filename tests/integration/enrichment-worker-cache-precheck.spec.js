/**
 * Integration test for the enrichment worker's cache-first pre-check
 * (B1 / BS#1747, under Epic C #877).
 *
 * B1 reads `album_metadata` for a linked flowsheet row's album BEFORE calling
 * LML and skips the call only when a load-bearing field (`artwork_url` /
 * `discogs_url`) is already non-null AND (BS#2295) at least one of the five
 * streaming URL columns is non-null. This spec validates the exact SQL
 * predicate that decision keys on, against the live `album_metadata` table
 * (FK to `library`, PK on `album_id`, the real column NULLability).
 *
 * The regression this locks down is BS#1089 negative-cache poisoning: the
 * no-match arm of `enrich.ts` writes an `album_metadata` row carrying ONLY
 * the four synthesized search URLs and leaves `artwork_url` / `discogs_url`
 * NULL. A naive "skip if any row exists" would freeze that false no-match
 * forever. The predicate under test MUST return false for such a shell (and
 * for an all-null row, and for a missing row) so the worker re-calls LML and
 * the row self-heals — and true ONLY when a real, persisted match is present.
 *
 * A second regression this locks down is BS#2295: a load-bearing match with
 * zero streaming columns populated used to skip anyway, and
 * `finalizeFromCachedMetadata` then stamped a terminal `enriched_match`
 * without ever writing those columns — five permanent nulls for every
 * client. The predicate MUST return false for that shape too (see the
 * describe block below) so the row falls through to LML and gets a real
 * chance to fill them, while an album that also carries at least one
 * streaming URL stays skipped (the #1747 amplifier guarantee).
 *
 * Pure SQL — does NOT import `apps/enrichment-worker/precheck.ts`. The
 * integration runner is babel-jest with no TS support (drizzle-orm + ts-jest
 * incompatibility; see `enrichment-worker-claim.spec.js` and
 * `album-metadata-upsert.spec.js` headers). The `hasLoadBearingMetadata`
 * helper is the shared canonical mirror of the TS SELECT in
 * `tests/utils/enrichment-precheck.js`; when `precheck.ts` is hand-edited
 * that helper must follow. Division of responsibility:
 *   - Unit (tests/unit/apps/enrichment-worker/cache-precheck.test.ts):
 *     the handler honors the pre-check verdict — skip vs. re-call LML.
 *   - Integration (this file): the SQL predicate's verdict for each real
 *     album_metadata shape.
 *
 * @see WXYC/Backend-Service#1747
 * @see WXYC/Backend-Service#1089
 * @see WXYC/Backend-Service#2295
 */

const { getTestDb } = require('../utils/db');
const { hasLoadBearingMetadata } = require('../utils/enrichment-precheck');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Insert a fresh library album to act as the album_metadata FK target.
 * Mirrors `album-metadata-upsert.spec.js#insertLibraryAlbum`: the seeded
 * fixture guarantees artist_id 1, genre_id 11, format_id 1 exist. Returns the
 * new id.
 */
async function insertLibraryAlbum(sql, suffix) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (1, 11, 1, ${'b1-precheck-test-album-' + suffix}, 9999, 'Stereolab')
    RETURNING id
  `;
  return rows[0].id;
}

describe('enrichment-worker cache-first pre-check predicate (real PG)', () => {
  let sql;
  /** album_ids inserted; deleted in afterAll regardless of pass/fail. */
  const insertedAlbumIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedAlbumIds.length > 0) {
      // album_metadata FK cascades on delete from library; delete it first
      // explicitly in case the FK is ever loosened.
      await sql`DELETE FROM ${sql(SCHEMA)}.album_metadata WHERE album_id = ANY(${insertedAlbumIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedAlbumIds})`;
    }
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  test('SKIP: non-null artwork_url is load-bearing, with a streaming URL present → true', async () => {
    // BS#2295: load-bearing alone is no longer sufficient (see the dedicated
    // describe block below) — this fixture also carries a streaming column so
    // it still pins the amplifier-preserving "true" case.
    const albumId = await insertLibraryAlbum(sql, 'artwork');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, spotify_url, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'https://open.spotify.com/search/Stereolab', NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('SKIP: non-null discogs_url is load-bearing, with a streaming URL present → true', async () => {
    // BS#2295: same amplifier-preserving pin as above, keyed on the other
    // load-bearing column.
    const albumId = await insertLibraryAlbum(sql, 'discogs');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, discogs_url, spotify_url, updated_at)
      VALUES (${albumId}, 'https://www.discogs.com/release/12345', 'https://open.spotify.com/search/Stereolab', NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('SELF-HEAL: missing album_metadata row → false (worker calls LML)', async () => {
    const albumId = await insertLibraryAlbum(sql, 'missing');
    insertedAlbumIds.push(albumId);
    // No album_metadata row inserted.

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('SELF-HEAL: all-null-load-bearing row → false (worker calls LML)', async () => {
    const albumId = await insertLibraryAlbum(sql, 'all-null');
    insertedAlbumIds.push(albumId);
    // Row exists but both load-bearing columns are NULL (e.g. a row that only
    // ever recorded release_year, or a torn write).
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, release_year, updated_at)
      VALUES (${albumId}, 2022, NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('SELF-HEAL (BS#1089 guard): search-URL-only shell → false (worker calls LML)', async () => {
    // The exact shape enrich.ts's linked no-match arm writes: the four
    // synthesized search URLs, both load-bearing columns NULL. This is the
    // poisoned no-match that must NOT be frozen — the predicate returns false
    // so the worker re-calls LML and the row self-heals.
    const albumId = await insertLibraryAlbum(sql, 'search-shell');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, spotify_url, youtube_music_url, bandcamp_url, soundcloud_url, updated_at)
      VALUES
        (${albumId},
         'https://open.spotify.com/search/Stereolab%20Aluminum%20Tunes',
         'https://music.youtube.com/search?q=Stereolab%20Aluminum%20Tunes',
         'https://bandcamp.com/search?q=Stereolab%20Aluminum%20Tunes',
         'https://soundcloud.com/search?q=Stereolab%20Aluminum%20Tunes',
         NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('SKIP: a shell later healed to carry artwork_url flips false → true', async () => {
    // End-to-end of the self-heal contract at the predicate layer: a poisoned
    // search-URL-only shell reads false (re-call), then once LML resolves a
    // real match and the load-bearing column is populated, the predicate
    // reads true (subsequent plays skip). No frozen false no-match.
    const albumId = await insertLibraryAlbum(sql, 'heal-flip');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, spotify_url, updated_at)
      VALUES (${albumId}, 'https://open.spotify.com/search/Stereolab', NOW())
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);

    await sql`
      UPDATE ${sql(SCHEMA)}.album_metadata
         SET artwork_url = 'https://i.discogs.com/b1/healed.jpg', updated_at = NOW()
       WHERE album_id = ${albumId}
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });
});

/**
 * BS#2295 — streaming-columns gate. A confirmed load-bearing match
 * (`artwork_url` OR `discogs_url`) is not "done" on its own: an album whose
 * `album_metadata` row carries one of those but none of the five streaming
 * URL columns used to skip the LML call anyway, and
 * `finalizeFromCachedMetadata` then stamped the flowsheet row terminal
 * (`enriched_match`) without ever writing those columns — permanent
 * five-null streaming URLs for every client. This is the exact shape
 * measured in the issue (4 of 152 recent track rows, all `artwork_url`
 * present / `discogs_url` NULL / all five streaming columns NULL).
 *
 * The fix must NOT widen the #1747 amplifier: an album that already carries
 * a load-bearing match AND at least one streaming URL stays skipped, so the
 * common already-enriched case pays no extra LML calls.
 *
 * @see WXYC/Backend-Service#2295
 * @see WXYC/Backend-Service#1747
 */
describe('enrichment-worker cache-first pre-check predicate — BS#2295 streaming-columns gate (real PG)', () => {
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

  // The exact frozen shape from the issue: a linked album with a real
  // Discogs match but zero streaming columns. Before BS#2295 every row here
  // read true (skip) and the flowsheet row froze on enriched_match with five
  // null streaming URLs forever. Both load-bearing columns are written
  // explicitly (NULL where absent) so the fixture states the whole
  // load-bearing shape rather than leaving half of it implied.
  test.each([
    ['artwork-only', 'https://i.discogs.com/b1/cover.jpg', null],
    ['discogs-only', null, 'https://www.discogs.com/release/99999'],
    ['both-load-bearing', 'https://i.discogs.com/b1/cover.jpg', 'https://www.discogs.com/release/99999'],
  ])(
    'NEWLY ASKED: %s, all five streaming columns NULL → false (worker calls LML)',
    async (slug, artworkUrl, discogsUrl) => {
      const albumId = await insertLibraryAlbum(sql, slug + '-no-streaming');
      insertedAlbumIds.push(albumId);
      await sql`
        INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, discogs_url, updated_at)
        VALUES (${albumId}, ${artworkUrl}, ${discogsUrl}, NOW())
      `;

      expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
    }
  );

  test.each([
    ['spotify_url', 'https://open.spotify.com/search/Stereolab'],
    ['apple_music_url', 'https://music.apple.com/album/aluminum-tunes'],
    ['youtube_music_url', 'https://music.youtube.com/search?q=Stereolab'],
    ['bandcamp_url', 'https://stereolab.bandcamp.com/album/aluminum-tunes'],
    ['soundcloud_url', 'https://soundcloud.com/search?q=Stereolab'],
  ])('STILL SKIPPED (amplifier guarantee): artwork_url present + %s alone → true', async (column, url) => {
    // Pins the still-skipped case explicitly, one streaming column at a
    // time: a load-bearing match with EXACTLY ONE streaming URL populated
    // must still skip LML, preserving the #1747 amplifier fix for the
    // common already-enriched case.
    const albumId = await insertLibraryAlbum(sql, 'still-skipped-' + column);
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, ${sql(column)}, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', ${url}, NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('SELF-HEAL flip: a load-bearing/no-streaming row flips true once LML fills a streaming URL', async () => {
    // End-to-end of the BS#2295 self-heal contract: the frozen shape reads
    // false (worker re-calls LML), then once the normal match-write path
    // fills in a streaming column alongside the existing artwork, the
    // predicate reads true (subsequent plays skip).
    const albumId = await insertLibraryAlbum(sql, 'streaming-heal-flip-2295');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', NOW())
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);

    await sql`
      UPDATE ${sql(SCHEMA)}.album_metadata
         SET spotify_url = 'https://open.spotify.com/search/Stereolab', updated_at = NOW()
       WHERE album_id = ${albumId}
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });
});

/**
 * BS#1915 — bounded self-heal of unresolved streaming links. Load-bearing
 * artwork/discogs alone is no longer sufficient to call a row "done": a
 * streaming field still `unresolved` and under the attempt cap must ALSO
 * keep the predicate false so the worker re-asks LML. `absent` stays
 * terminal (never re-asked, preserving #1747), and NULL (never-consulted)
 * must not be mistaken for a re-ask-eligible `unresolved`.
 *
 * @see WXYC/Backend-Service#1915
 * @see WXYC/library-metadata-lookup#1053
 */
describe('enrichment-worker cache-first pre-check predicate — BS#1915 streaming self-heal gate (real PG)', () => {
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

  test('SELF-HEAL: load-bearing artwork present but apple_music unresolved under the cap → false (worker re-asks)', async () => {
    const albumId = await insertLibraryAlbum(sql, 'streaming-unresolved-under-cap');
    insertedAlbumIds.push(albumId);
    // BS#2295: a streaming URL (spotify_url) is included so this fixture
    // isolates the re-ask gate under test from the separate
    // streaming-columns-presence gate. Without it this test would read false
    // via BS#2295 alone and stop exercising `needsStreamingReask` at all —
    // it is the ONLY false-arm coverage the BS#1915 gate has.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, spotify_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'https://open.spotify.com/search/Stereolab', 'unresolved', 0, NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('BOUNDED: the same unresolved field stops being re-ask-eligible once the attempt cap is hit → true', async () => {
    const albumId = await insertLibraryAlbum(sql, 'streaming-unresolved-at-cap');
    insertedAlbumIds.push(albumId);
    // BS#2295: a streaming URL (spotify_url) is included so this fixture
    // isolates the attempt-cap logic under test from the separate
    // streaming-columns-presence gate (see that describe block).
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, spotify_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'https://open.spotify.com/search/Stereolab', 'unresolved', 3, NOW())
    `;

    // No unbounded re-ask loop: attempts >= STREAMING_REASK_ATTEMPT_CAP (3)
    // means the worker accepts the frozen null and stops asking.
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('TERMINAL: an absent streaming field is never re-asked, regardless of the attempt count', async () => {
    const albumId = await insertLibraryAlbum(sql, 'streaming-absent');
    insertedAlbumIds.push(albumId);
    // BS#2295: a streaming URL is included for the same isolation reason.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, spotify_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'https://open.spotify.com/search/Stereolab', 'absent', 0, NOW())
    `;

    // 'absent' is terminal — negative-cached, never re-asked, preserving the
    // #1747 amplifier fix. True even with zero prior attempts.
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('NEVER-CONSULTED: a NULL streaming status (not unresolved, not absent) does not force a re-ask', async () => {
    const albumId = await insertLibraryAlbum(sql, 'streaming-never-consulted');
    insertedAlbumIds.push(albumId);
    // apple_music_status left NULL — the key-omission convention for
    // "never consulted." Must NOT be treated as re-ask-eligible the way
    // 'unresolved' is. BS#2295: a streaming URL is included for the same
    // isolation reason as the two tests above.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata (album_id, artwork_url, spotify_url, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'https://open.spotify.com/search/Stereolab', NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('ANY-FIELD: one unresolved-under-cap field blocks "done" even when the other two are resolved', async () => {
    const albumId = await insertLibraryAlbum(sql, 'streaming-mixed-verdicts');
    insertedAlbumIds.push(albumId);
    // BS#2295: `spotify_url` accompanies the 'verified' spotify_status --
    // both because a verified verdict without a URL is a shape no writer
    // produces, and so the expected false is attributable to the unresolved
    // apple_music field under test rather than to the streaming-columns gate.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, spotify_url, spotify_status, bandcamp_status, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'https://open.spotify.com/album/aluminum-tunes', 'verified', 'absent', 'unresolved', 1, NOW())
    `;

    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('SELF-HEAL flip: unresolved-under-cap flips to verified → predicate flips false → true', async () => {
    const albumId = await insertLibraryAlbum(sql, 'streaming-heal-flip');
    insertedAlbumIds.push(albumId);
    // BS#2295: a streaming URL is present from the start so the opening
    // false comes from the unresolved-under-cap verdict, not from the
    // streaming-columns gate -- otherwise the UPDATE below would flip the
    // predicate for two reasons at once and pin neither.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, spotify_url, apple_music_status, streaming_reask_attempts, updated_at)
      VALUES (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'https://open.spotify.com/search/Stereolab', 'unresolved', 1, NOW())
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);

    await sql`
      UPDATE ${sql(SCHEMA)}.album_metadata
         SET apple_music_status = 'verified',
             apple_music_url = 'https://music.apple.com/album/healed',
             updated_at = NOW()
       WHERE album_id = ${albumId}
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });
});

/**
 * Bandcamp re-ask de-freeze (ENRICHMENT_BANDCAMP_REASK) — the precheck gate.
 * A load-bearing row whose Bandcamp is the legacy frozen shape
 * (`bandcamp_status = NULL` + a `bandcamp.com/search` fallback URL) is
 * "done" today (skip LML), which is the freeze. With the gate on, it is NOT
 * done: the predicate returns false so a subsequent PLAY re-asks LML. Flag
 * off is a byte-for-byte no-op (asserted alongside each on case). Mirrors the
 * positive form validated in `enrichment-worker-streaming-reask.spec.js`.
 *
 * @see WXYC/Backend-Service#1747 (the freeze), #1915 (the self-heal sweep)
 */
describe('enrichment-worker cache-first pre-check predicate — Bandcamp de-freeze gate (real PG)', () => {
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
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, bandcamp_url, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'https://bandcamp.com/search?q=Stereolab%20Aluminum%20Tunes', NOW())
    `;
    return albumId;
  }

  test('FLAG OFF: a NULL-status search-fallback bandcamp row is still "done" → true (skip, current behavior)', async () => {
    delete process.env.ENRICHMENT_BANDCAMP_REASK;
    const albumId = await insertFrozenBandcampRow(sql, 'precheck-off');
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('FLAG ON: the same frozen bandcamp row is NOT done → false (worker re-asks LML on the next play)', async () => {
    process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
    const albumId = await insertFrozenBandcampRow(sql, 'precheck-on');
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(false);
  });

  test('FLAG ON: an absent bandcamp with a search-fallback url stays "done" → true (terminal, never re-asked)', async () => {
    process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
    const albumId = await insertLibraryAlbum(sql, 'bandcamp-absent-precheck');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, bandcamp_status, bandcamp_url, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'absent', 'https://bandcamp.com/search?q=x', NOW())
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });

  test('FLAG ON: a verified bandcamp (direct url, not a search fallback) stays "done" → true', async () => {
    process.env.ENRICHMENT_BANDCAMP_REASK = 'true';
    const albumId = await insertLibraryAlbum(sql, 'bandcamp-verified-precheck');
    insertedAlbumIds.push(albumId);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_metadata
        (album_id, artwork_url, bandcamp_status, bandcamp_url, updated_at)
      VALUES
        (${albumId}, 'https://i.discogs.com/b1/cover.jpg', 'verified', 'https://stereolab.bandcamp.com/album/aluminum-tunes', NOW())
    `;
    expect(await hasLoadBearingMetadata(sql, albumId)).toBe(true);
  });
});
