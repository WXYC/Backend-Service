/**
 * Integration test for jobs/uncovered-release-list's DB-only surfaces
 * (BS#1877, ADR 0013's "uncovered-release list handoff", widened by the
 * "rotation ∪ recently played" amendment).
 *
 * The unit suite (tests/unit/jobs/uncovered-release-list/*.test.ts) mocks
 * `db.execute` entirely, so it never exercises the real SQL shape. This
 * spec validates the parts only real PostgreSQL can settle:
 *
 *   1. The rotation × rotation_library_view COALESCE join (rotation.ts):
 *      an album_id-linked row resolves its canonical (artist, album) via
 *      the view; a snapshot-only row (album_id NULL) falls back to its own
 *      snapshot columns; a killed (inactive) row is excluded from both.
 *   2. Both anti-joins (antijoin.ts): a release with an existing
 *      album_critic_reviews row is excluded by loadCoveredLibraryIds's
 *      query shape; a release with an existing
 *      uncovered_release_search_markers row is excluded by
 *      loadHandedOffLibraryIds's query shape.
 *   3. uncovered_release_search_markers' UPSERT conflict target
 *      (migration 0146): re-recording a handoff for the same album_id
 *      updates in place (bumps handoff_count, refreshes
 *      last_handed_off_at) rather than duplicating.
 *   4. ON DELETE CASCADE: dropping the library album evaporates its
 *      uncovered_release_search_markers row, mirroring
 *      album_critic_reviews' own cascade (critic-reviews-metadata.spec.js).
 *   5. The play arm (plays.ts), both sub-arms: the steady-state windowed
 *      `flowsheet` aggregate (`fetchRecentPlays`) and the `--backfill`
 *      `album_plays` MV read (`fetchAllPlayedAlbums`), each scoped to this
 *      spec's own fixture rows (see `scopedWindowAggregate` /
 *      `scopedAlbumPlays` below for why the scoping is a deliberate,
 *      test-isolation-only divergence from the production queries).
 *
 * Pure SQL — does NOT import the TS job modules (babel-jest has no TS
 * transform registered for jest.config.json; see
 * critic-reviews-metadata.spec.js's header for the same constraint). Each
 * query below is hand-mirrored from the real module; when that module's SQL
 * is edited, the query here must follow.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/** Mirrors rotation.ts's fetchActiveRotationRows. */
async function fetchActiveRotationRows(sql) {
  return sql`
    SELECT
      r."id" AS rotation_id,
      COALESCE(v."library_id", r."album_id") AS library_id,
      COALESCE(v."artist_name", r."artist_name") AS artist_name,
      COALESCE(v."album_title", r."album_title") AS album_title
    FROM ${sql(SCHEMA)}.rotation r
    LEFT JOIN ${sql(SCHEMA)}.rotation_library_view v ON v."rotation_id" = r."id"
    WHERE r."kill_date" IS NULL OR r."kill_date" > CURRENT_DATE
    ORDER BY r."id"
  `;
}

/** Mirrors antijoin.ts's loadCoveredLibraryIds. */
async function loadCoveredLibraryIds(sql, libraryIds) {
  const rows = await sql`
    SELECT DISTINCT "album_id"
    FROM ${sql(SCHEMA)}.album_critic_reviews
    WHERE "album_id" = ANY(${`{${libraryIds.join(',')}}`}::int[])
  `;
  return new Set(rows.map((r) => r.album_id));
}

/** Mirrors antijoin.ts's loadHandedOffLibraryIds. */
async function loadHandedOffLibraryIds(sql, libraryIds) {
  const rows = await sql`
    SELECT "album_id"
    FROM ${sql(SCHEMA)}.uncovered_release_search_markers
    WHERE "album_id" = ANY(${`{${libraryIds.join(',')}}`}::int[])
  `;
  return new Set(rows.map((r) => r.album_id));
}

/** Mirrors markers.ts's recordHandoffs (single-row form). */
async function recordHandoff(sql, albumId) {
  return sql`
    INSERT INTO ${sql(SCHEMA)}.uncovered_release_search_markers (album_id)
    VALUES (${albumId})
    ON CONFLICT (album_id) DO UPDATE
       SET last_handed_off_at = now(),
           handoff_count = ${sql(SCHEMA)}.uncovered_release_search_markers.handoff_count + 1
    RETURNING id, handoff_count
  `;
}

async function insertArtist(sql, name) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
    VALUES (${name}, ${name}, 'ZZ')
    RETURNING id
  `;
  return rows[0].id;
}

async function insertLibraryAlbum(sql, artistId, title) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.library
      (artist_id, genre_id, format_id, album_title, code_number, artist_name)
    VALUES
      (${artistId}, 11, 1, ${title}, 9999, NULL)
    RETURNING id
  `;
  return rows[0].id;
}

async function insertRotationRow(sql, { albumId = null, artistName = null, albumTitle = null, killDate = null }) {
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin, artist_name, album_title, add_date, kill_date)
    VALUES (${albumId}, 'H', ${artistName}, ${albumTitle}, '2024-01-01', ${killDate})
    RETURNING id
  `;
  return rows[0].id;
}

// Distinct play_order base for this spec's play-arm fixtures, well clear of
// other specs' ranges (mirrors library-query-sort-plays.spec.js's 9200+ /
// catalog-popularity-freetext-resolve-enumerate.spec.js's 97671 convention).
let flowsheetPlayOrder = 98100;

/** Insert one 'track' flowsheet row with an explicit add_time (BS#1877
 *  play-arm fixtures — the caller controls whether it lands inside or
 *  outside a steady-state lookback window). */
async function insertFlowsheetTrack(sql, { albumId, artistName, albumTitle, addTime }) {
  flowsheetPlayOrder += 1;
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (play_order, entry_type, artist_name, album_title, track_title, album_id, add_time)
    VALUES
      (${flowsheetPlayOrder}, 'track', ${artistName}, ${albumTitle}, 'BS1877 Track', ${albumId}, ${addTime})
    RETURNING id
  `;
  return rows[0].id;
}

/** Insert one non-'track' flowsheet row (a talkset) — used to prove the
 *  play arm's `entry_type = 'track'` predicate excludes it from both
 *  sub-arms (the windowed aggregate and the album_plays MV, which shares
 *  the identical predicate in its own defining SELECT). */
async function insertFlowsheetTalkset(sql, { albumId, addTime }) {
  flowsheetPlayOrder += 1;
  const rows = await sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet (play_order, entry_type, album_id, add_time)
    VALUES (${flowsheetPlayOrder}, 'talkset', ${albumId}, ${addTime})
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Mirrors plays.ts's fetchRecentPlays (the steady-state play arm), scoped
 * to this spec's own `libraryIds` via an extra `AND f.album_id = ANY(...)`
 * clause the production query does not carry. This is a *deliberate
 * divergence*, not an oversight: the suite runs `--runInBand` over shared
 * `flowsheet` state, so an unscoped `GROUP BY album_id` would see rows other
 * specs (and other tests in this file) left behind and make the
 * distinctness/ordering assertions below flaky. When plays.ts's SQL is
 * edited, this query must follow, per the module header above.
 */
async function scopedWindowAggregate(sql, libraryIds, lookbackDays) {
  return sql`
    SELECT f."album_id" AS library_id, a."artist_name" AS artist_name, l."album_title" AS album_title, COUNT(*)::int AS play_count
    FROM ${sql(SCHEMA)}.flowsheet f
    JOIN ${sql(SCHEMA)}.library l ON l."id" = f."album_id"
    JOIN ${sql(SCHEMA)}.artists a ON a."id" = l."artist_id"
    WHERE f."entry_type" = 'track' AND f."album_id" IS NOT NULL
      AND f."add_time" >= now() - (interval '1 day' * ${lookbackDays})
      AND f."album_id" = ANY(${libraryIds})
    GROUP BY f."album_id", a."artist_name", l."album_title"
    ORDER BY play_count DESC, f."album_id" ASC
  `;
}

/**
 * Mirrors plays.ts's fetchAllPlayedAlbums (the `--backfill` play arm,
 * sourced from the `album_plays` MV), scoped to this spec's own
 * `libraryIds` — same test-isolation-only divergence as
 * scopedWindowAggregate above. Callers must `REFRESH MATERIALIZED VIEW
 * album_plays` first via `sql.unsafe` (not a tagged template — postgres-js
 * can't parameterize DDL), the same recipe
 * library-query-sort-plays.spec.js and library-catalog-export.spec.js use.
 */
async function scopedAlbumPlays(sql, libraryIds) {
  return sql`
    SELECT p."album_id" AS library_id, a."artist_name" AS artist_name, l."album_title" AS album_title, p."plays" AS play_count
    FROM ${sql(SCHEMA)}.album_plays p
    JOIN ${sql(SCHEMA)}.library l ON l."id" = p."album_id"
    JOIN ${sql(SCHEMA)}.artists a ON a."id" = l."artist_id"
    WHERE p."album_id" = ANY(${libraryIds})
    ORDER BY p."plays" DESC, p."album_id" ASC
  `;
}

describe('uncovered-release-list DB-only surfaces (real PG)', () => {
  let sql;
  const insertedArtistIds = [];
  const insertedLibraryIds = [];
  const insertedRotationIds = [];
  const insertedFlowsheetIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedFlowsheetIds.length > 0) {
      // Delete the play-arm fixture rows before touching library — flowsheet's
      // album_id FK is ON DELETE SET NULL, so this ordering isn't required for
      // referential integrity, but doing it first keeps the album_plays MV
      // refresh below meaningful (nothing left to roll off).
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${insertedFlowsheetIds})`;
    }
    if (insertedRotationIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${insertedRotationIds})`;
    }
    if (insertedLibraryIds.length > 0) {
      // uncovered_release_search_markers + album_critic_reviews both cascade
      // off library; deleting library is sufficient, but target the child
      // tables explicitly first (belt + suspenders, same posture as
      // critic-reviews-metadata.spec.js).
      await sql`DELETE FROM ${sql(SCHEMA)}.uncovered_release_search_markers WHERE album_id = ANY(${insertedLibraryIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.album_critic_reviews WHERE album_id = ANY(${insertedLibraryIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${insertedLibraryIds})`;
    }
    if (insertedArtistIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ANY(${insertedArtistIds})`;
    }
    // Drop any now-stale backfill-arm fixture rows from the MV so they can't
    // leak into a later test's read (mirrors library-catalog-export.spec.js's
    // / library-query-sort-plays.spec.js's convention). Harmless no-op when
    // this spec's backfill test never ran (or ran but nothing was refreshed).
    await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);
  });

  test('COALESCE join: an album_id-linked active row resolves canonical fields via rotation_library_view', async () => {
    const artistId = await insertArtist(sql, 'BS1877 Linked Artist');
    insertedArtistIds.push(artistId);
    const libraryId = await insertLibraryAlbum(sql, artistId, 'BS1877 Linked Album');
    insertedLibraryIds.push(libraryId);
    const rotationId = await insertRotationRow(sql, { albumId: libraryId });
    insertedRotationIds.push(rotationId);

    const rows = await fetchActiveRotationRows(sql);
    const row = rows.find((r) => r.rotation_id === rotationId);

    expect(row).toBeDefined();
    expect(row.library_id).toBe(libraryId);
    expect(row.artist_name).toBe('BS1877 Linked Artist');
    expect(row.album_title).toBe('BS1877 Linked Album');
  });

  test('COALESCE join: a snapshot-only active row (album_id NULL) falls back to its own artist_name/album_title', async () => {
    const rotationId = await insertRotationRow(sql, {
      albumId: null,
      artistName: 'BS1877 Snapshot Artist',
      albumTitle: 'BS1877 Snapshot Album',
    });
    insertedRotationIds.push(rotationId);

    const rows = await fetchActiveRotationRows(sql);
    const row = rows.find((r) => r.rotation_id === rotationId);

    expect(row).toBeDefined();
    expect(row.library_id).toBeNull();
    expect(row.artist_name).toBe('BS1877 Snapshot Artist');
    expect(row.album_title).toBe('BS1877 Snapshot Album');
  });

  test('COALESCE join: a killed (inactive) row is excluded entirely', async () => {
    const rotationId = await insertRotationRow(sql, {
      albumId: null,
      artistName: 'BS1877 Killed Artist',
      albumTitle: 'BS1877 Killed Album',
      killDate: '2020-01-01',
    });
    insertedRotationIds.push(rotationId);

    const rows = await fetchActiveRotationRows(sql);
    expect(rows.find((r) => r.rotation_id === rotationId)).toBeUndefined();
  });

  test('loadCoveredLibraryIds excludes a library_id that already has an album_critic_reviews row', async () => {
    const artistId = await insertArtist(sql, 'BS1877 Covered Artist');
    insertedArtistIds.push(artistId);
    const coveredId = await insertLibraryAlbum(sql, artistId, 'BS1877 Covered Album');
    const uncoveredId = await insertLibraryAlbum(sql, artistId, 'BS1877 Uncovered Album');
    insertedLibraryIds.push(coveredId, uncoveredId);

    await sql`
      INSERT INTO ${sql(SCHEMA)}.album_critic_reviews (album_id, source, source_url, snippet)
      VALUES (${coveredId}, 'Test Source', 'https://example.com/bs1877-covered', 'A snippet.')
    `;

    const covered = await loadCoveredLibraryIds(sql, [coveredId, uncoveredId]);

    expect(covered.has(coveredId)).toBe(true);
    expect(covered.has(uncoveredId)).toBe(false);
  });

  test('loadHandedOffLibraryIds excludes a library_id already recorded in uncovered_release_search_markers', async () => {
    const artistId = await insertArtist(sql, 'BS1877 HandedOff Artist');
    insertedArtistIds.push(artistId);
    const handedOffId = await insertLibraryAlbum(sql, artistId, 'BS1877 HandedOff Album');
    const freshId = await insertLibraryAlbum(sql, artistId, 'BS1877 Fresh Album');
    insertedLibraryIds.push(handedOffId, freshId);

    await recordHandoff(sql, handedOffId);

    const handedOff = await loadHandedOffLibraryIds(sql, [handedOffId, freshId]);

    expect(handedOff.has(handedOffId)).toBe(true);
    expect(handedOff.has(freshId)).toBe(false);
  });

  test('uncovered_release_search_markers UPSERT: a repeat handoff updates in place and bumps handoff_count', async () => {
    const artistId = await insertArtist(sql, 'BS1877 Repeat Artist');
    insertedArtistIds.push(artistId);
    const libraryId = await insertLibraryAlbum(sql, artistId, 'BS1877 Repeat Album');
    insertedLibraryIds.push(libraryId);

    const first = await recordHandoff(sql, libraryId);
    expect(first[0].handoff_count).toBe(1);

    const second = await recordHandoff(sql, libraryId);
    expect(second[0].handoff_count).toBe(2);
    expect(second[0].id).toBe(first[0].id); // same row, not a duplicate

    const all = await sql`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.uncovered_release_search_markers WHERE album_id = ${libraryId}
    `;
    expect(all[0].n).toBe(1);
  });

  test('ON DELETE CASCADE: dropping the library album evaporates its uncovered_release_search_markers row', async () => {
    const artistId = await insertArtist(sql, 'BS1877 Cascade Artist');
    insertedArtistIds.push(artistId);
    const libraryId = await insertLibraryAlbum(sql, artistId, 'BS1877 Cascade Album');
    // Intentionally NOT pushed to insertedLibraryIds — consumed by this
    // test's own DELETE below, mirroring critic-reviews-metadata.spec.js's
    // cascade test so afterAll doesn't double-delete a vanished row.

    await recordHandoff(sql, libraryId);

    const before = await sql`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.uncovered_release_search_markers WHERE album_id = ${libraryId}
    `;
    expect(before[0].n).toBe(1);

    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ${libraryId}`;

    const after = await sql`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.uncovered_release_search_markers WHERE album_id = ${libraryId}
    `;
    expect(after[0].n).toBe(0);
  });

  test('play arm — steady state: scopedWindowAggregate groups by album_id, excludes plays outside the lookback window and non-track entries, orders play_count desc', async () => {
    const artistId = await insertArtist(sql, 'BS1877 Play Steady Artist');
    insertedArtistIds.push(artistId);
    const albumA = await insertLibraryAlbum(sql, artistId, 'BS1877 Play Steady Album A');
    const albumB = await insertLibraryAlbum(sql, artistId, 'BS1877 Play Steady Album B');
    const albumC = await insertLibraryAlbum(sql, artistId, 'BS1877 Play Steady Album C Outside Window');
    insertedLibraryIds.push(albumA, albumB, albumC);

    const withinWindow = new Date();
    const outsideWindow = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40d ago, outside a 30d lookback

    for (let i = 0; i < 3; i += 1) {
      insertedFlowsheetIds.push(
        await insertFlowsheetTrack(sql, {
          albumId: albumA,
          artistName: 'BS1877 Play Steady Artist',
          albumTitle: 'BS1877 Play Steady Album A',
          addTime: withinWindow,
        })
      );
    }
    insertedFlowsheetIds.push(
      await insertFlowsheetTrack(sql, {
        albumId: albumB,
        artistName: 'BS1877 Play Steady Artist',
        albumTitle: 'BS1877 Play Steady Album B',
        addTime: withinWindow,
      })
    );
    for (let i = 0; i < 2; i += 1) {
      insertedFlowsheetIds.push(
        await insertFlowsheetTrack(sql, {
          albumId: albumC,
          artistName: 'BS1877 Play Steady Artist',
          albumTitle: 'BS1877 Play Steady Album C Outside Window',
          addTime: outsideWindow,
        })
      );
    }
    // A non-track entry within the window on album A must not inflate its count.
    insertedFlowsheetIds.push(await insertFlowsheetTalkset(sql, { albumId: albumA, addTime: withinWindow }));

    const rows = await scopedWindowAggregate(sql, [albumA, albumB, albumC], 30);

    // Album C is outside the 30d window entirely; A outranks B on play_count.
    expect(rows.map((r) => r.library_id)).toEqual([albumA, albumB]);
    const byId = new Map(rows.map((r) => [r.library_id, r]));
    expect(byId.get(albumA).play_count).toBe(3);
    expect(byId.get(albumA).artist_name).toBe('BS1877 Play Steady Artist');
    expect(byId.get(albumA).album_title).toBe('BS1877 Play Steady Album A');
    expect(byId.get(albumB).play_count).toBe(1);
  });

  test('play arm — backfill: scopedAlbumPlays sources the album_plays MV (no time window), excludes an album with only a non-track entry', async () => {
    const artistId = await insertArtist(sql, 'BS1877 Play Backfill Artist');
    insertedArtistIds.push(artistId);
    const albumD = await insertLibraryAlbum(sql, artistId, 'BS1877 Play Backfill Album D');
    const albumE = await insertLibraryAlbum(sql, artistId, 'BS1877 Play Backfill Album E Talkset Only');
    insertedLibraryIds.push(albumD, albumE);

    // Well outside any steady-state lookback window — the backfill arm has
    // no time predicate at all and must still see these plays.
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

    for (let i = 0; i < 5; i += 1) {
      insertedFlowsheetIds.push(
        await insertFlowsheetTrack(sql, {
          albumId: albumD,
          artistName: 'BS1877 Play Backfill Artist',
          albumTitle: 'BS1877 Play Backfill Album D',
          addTime: longAgo,
        })
      );
    }
    insertedFlowsheetIds.push(await insertFlowsheetTalkset(sql, { albumId: albumE, addTime: longAgo }));

    await sql.unsafe(`REFRESH MATERIALIZED VIEW "${SCHEMA}".album_plays`);

    const rows = await scopedAlbumPlays(sql, [albumD, albumE]);

    // Album E never appears: its only flowsheet row is a talkset, and
    // album_plays' own defining SELECT carries entry_type='track' — no MV
    // row exists at all for an album with zero track plays.
    expect(rows.map((r) => r.library_id)).toEqual([albumD]);
    expect(rows[0].play_count).toBe(5);
    expect(rows[0].artist_name).toBe('BS1877 Play Backfill Artist');
    expect(rows[0].album_title).toBe('BS1877 Play Backfill Album D');
  });
});
