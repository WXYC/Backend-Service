/**
 * Integration test for the catalog-popularity-freetext-resolve ENUMERATE
 * representative-track selection (BS#1767), against real PostgreSQL.
 *
 * The unit suite (job.test.ts) imports the REAL `enumerateFreetextPairs` and
 * pins the exact GROUP BY + DISTINCT ON + ORDER BY it emits (so flipping an
 * ASC/DESC, dropping the btrim non-empty-first term, or changing the GROUP BY
 * fails there). This spec validates that pinned SQL's *runtime semantics*
 * against real PG — which track the modal ordering actually resolves to — the
 * one thing a string assertion can't observe.
 *
 * It cannot import the job directly: the integration runner is babel-jest with
 * no TS transform (the job uses `import type`, which the parser rejects), so
 * this mirrors the enumerate statement verbatim, scoped by an `ILIKE '%bs1767%'`
 * marker. That is the same pure-SQL convention every sibling spec uses
 * (flowsheet-metadata-backfill-worklist / -upsert, flowsheet-artwork-repair):
 * WHEN `enumerateFreetextPairs` is hand-edited, BOTH the unit-suite SQL
 * assertions AND this statement must follow — the unit suite is the drift
 * tripwire on the real query, this is the semantics check on that query's shape.
 *
 * Seeded matrix (all rows carry a "bs1767" marker so the scoped query, cleanup,
 * and assertions stay hermetic; album_id NULL so they're unlinked):
 *   - Pair A ('bs1767 artist a', 'bs1767 album a'):
 *       NULL   track × 5 plays  (most-played OVERALL, but empty → must NOT win)
 *       'Modal Track' × 3 plays (most-played NON-empty → MUST win)
 *       'Other Track' × 1 play
 *     → song === 'Modal Track'. Proves non-empty-first dominates raw play_count
 *       AND that most-played wins among the non-empty tracks.
 *   - Pair B ('bs1767 artist b', 'bs1767 album b'):
 *       NULL track × 2 plays
 *       ''   track × 1 play
 *     → song === '' (all tracks unusable → album-only fallback, still enumerated).
 *
 * Cardinality: exactly one row per distinct pair (2 pairs → 2 rows). The inner
 * GROUP BY only picks a better representative track; it does not change which
 * pairs are enumerated.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Mirror of the enumerate statement in
 * `jobs/catalog-popularity-freetext-resolve/job.ts:enumerateFreetextPairs`
 * (inner GROUP BY play-count + DISTINCT ON non-empty-first / most-played /
 * deterministic ordering), scoped by an `ILIKE '%bs1767%'` marker so it only
 * sees this spec's rows. Returns `{ artist_name, album_title, track_title }`
 * one row per `(artist, album)` pair.
 */
async function scopedEnumerate(sql) {
  return await sql`
    SELECT DISTINCT ON ("artist_name", "album_title")
           "artist_name", "album_title", "track_title"
    FROM (
      SELECT "artist_name", "album_title", "track_title", count(*) AS play_count
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE "entry_type" = 'track'
        AND "album_id" IS NULL
        AND "artist_name" IS NOT NULL
        AND "album_title" IS NOT NULL
        AND "artist_name" ILIKE '%bs1767%'
      GROUP BY "artist_name", "album_title", "track_title"
    ) g
    ORDER BY "artist_name", "album_title",
             (btrim(coalesce("track_title", '')) = '') ASC,
             play_count DESC,
             "track_title" ASC
  `;
}

/** Derive `song` exactly as the enumerate map does: trim once at the boundary,
 * NULL → '' . */
const songOf = (row) => (row.track_title ?? '').trim();

describe('catalog-popularity-freetext-resolve enumerate representative track (real PG, BS#1767)', () => {
  let sql;
  const flowsheetIds = [];

  /** Insert one unlinked flowsheet track row (album_id NULL). */
  async function seedPlay(artist, album, track) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title,
         request_flag, segue, album_id, add_time)
      VALUES
        (97671, 'track', ${artist}, ${album}, ${track},
         false, false, null, now() - interval '30 days')
      RETURNING id
    `;
    flowsheetIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    sql = getTestDb();

    // Pair A — most-played NON-empty track must win over a more-played empty one.
    for (let i = 0; i < 5; i += 1) await seedPlay('bs1767 artist a', 'bs1767 album a', null);
    for (let i = 0; i < 3; i += 1) await seedPlay('bs1767 artist a', 'bs1767 album a', 'Modal Track');
    await seedPlay('bs1767 artist a', 'bs1767 album a', 'Other Track');

    // Pair B — all tracks unusable → album-only fallback, still enumerated.
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1767 artist b', 'bs1767 album b', null);
    await seedPlay('bs1767 artist b', 'bs1767 album b', '');
  });

  afterAll(async () => {
    if (flowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${flowsheetIds})`;
    }
  });

  it('returns exactly one row per distinct (artist, album) pair (cardinality unchanged)', async () => {
    const rows = await scopedEnumerate(sql);
    expect(rows).toHaveLength(2);
    const pairs = rows.map((r) => `${r.artist_name} | ${r.album_title}`).sort();
    expect(pairs).toEqual(['bs1767 artist a | bs1767 album a', 'bs1767 artist b | bs1767 album b']);
  });

  it('picks the most-played NON-empty track as the representative song (non-empty-first beats raw play_count)', async () => {
    const rows = await scopedEnumerate(sql);
    const pairA = rows.find((r) => r.artist_name === 'bs1767 artist a');
    expect(pairA).toBeDefined();
    // The NULL track has 5 plays vs 'Modal Track' 3, but non-empty sorts first
    // in the DISTINCT ON ordering, then most-played wins among the non-empty.
    expect(pairA.track_title).toBe('Modal Track');
    expect(songOf(pairA)).toBe('Modal Track');
  });

  it("enumerates a track-less pair with song='' (album-only fallback, never dropped)", async () => {
    const rows = await scopedEnumerate(sql);
    const pairB = rows.find((r) => r.artist_name === 'bs1767 artist b');
    // The pair is present (not filtered out by a track_title IS NOT NULL), and
    // its representative track collapses to '' at the enumerate boundary.
    expect(pairB).toBeDefined();
    expect(songOf(pairB)).toBe('');
  });
});
