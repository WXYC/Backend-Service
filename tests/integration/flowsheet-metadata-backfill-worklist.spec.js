/**
 * Integration test for the flowsheet-metadata-backfill play-priority
 * work-list SELECT (BS#1591), against real PostgreSQL.
 *
 * The unit suite (worklist.test.ts) pins the statement's *shape* under the
 * mocked drizzle harness; this spec validates its *semantics* — the
 * eligibility matrix, the normalization-driven library exemption, and the
 * priority ordering — including the real `normalize_artist_name` SQL
 * function from migration 0092 ("The " prefix strip + case fold on both
 * sides of the membership join).
 *
 * Seeded matrix (all artists carry a "bs1591" marker so the mirrored query
 * can scope itself; every historical row's add_time is back-dated past the
 * 60s race guard):
 *   - bs1591-highplay: 6 pending plays, non-library → eligible (>= floor 5)
 *   - bs1591-boosted: 2 pending + 4 already-stamped plays, non-library →
 *     eligible (plays counts ALL rows, not just pending)
 *   - bs1591-lowfreq: 2 pending plays, non-library → EXCLUDED (below floor)
 *   - The bs1591-Catalog-Artist: 1 play, matches artists row
 *     "BS1591-catalog-artist" after normalization → eligible (library)
 *   - bs1591-alias-variant: 1 play, matches artist_search_alias variant
 *     "The BS1591-Alias-Variant" after normalization → eligible (alias arm;
 *     its canonical artists row has a different name, isolating the arm)
 *   - bs1591-linked: 1 play, album_id set → eligible (linked by construction)
 *   - bs1591-recent: 1 play, non-library, add_time 1h ago → eligible
 *     (recency exemption, decision 5)
 *   - bs1591-tie-a / bs1591-tie-b: 2 plays each, both library → eligible;
 *     pin the artist_norm tiebreak (same-artist contiguity under play ties)
 *
 * Complement property: within the scoped pending set,
 * `worklist_size + below_floor == pending_total` — the identity that makes
 * the production job's subtraction-based below_floor_skipped valid.
 *
 * Pure SQL — does NOT import `jobs/flowsheet-metadata-backfill/worklist.ts`.
 * Integration runner is babel-jest with no TS support; the statement below
 * mirrors `buildWorkList` (plus a test-hermetic `ILIKE '%bs1591%'` scope and
 * an artist_name projection for readable assertions). When worklist.ts is
 * hand-edited the SQL here must follow.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const PLAY_FLOOR = 5;
const RECENCY_DAYS = 7;

/** The scoped pending predicate shared by both mirrored statements. */
async function countScopedPending(sql) {
  const rows = await sql`
    SELECT COUNT(*)::int AS pending_total
    FROM ${sql(SCHEMA)}.flowsheet f
    WHERE f."entry_type" = 'track'
      AND f."artist_name" IS NOT NULL
      AND f."metadata_attempt_at" IS NULL
      AND f."add_time" < now() - interval '60 seconds'
      AND f."artist_name" ILIKE '%bs1591%'
  `;
  return rows[0].pending_total;
}

/**
 * Mirror of the work-list statement in
 * `jobs/flowsheet-metadata-backfill/worklist.ts:buildWorkList`, INCLUDING
 * its conditional assembly: the recency arm is omitted at recencyDays=0 and
 * the whole eligibility clause at playFloor=0, so the floor-0 / recency-0
 * tests below execute the same statement SHAPES production would render
 * (a tautology stand-in would hide a dangling AND/OR in the omitted
 * shapes). Arm order mirrors production too — free comparisons before the
 * correlated EXISTS, which probes the join-bound p.artist_norm.
 */
async function scopedWorkList(sql, { playFloor = PLAY_FLOOR, recencyDays = RECENCY_DAYS } = {}) {
  const recencyArm = recencyDays > 0 ? sql`OR f."add_time" > now() - (${recencyDays} * interval '1 day')` : sql``;
  const eligibility =
    playFloor > 0
      ? sql`AND (
        f."album_id" IS NOT NULL
        OR p.plays >= ${playFloor} ${recencyArm}
        OR EXISTS (
          SELECT 1 FROM library_artists la
          WHERE la.artist_norm = p.artist_norm
        )
      )`
      : sql``;
  return await sql`
    WITH plays AS (
      SELECT ${sql(SCHEMA)}.normalize_artist_name("artist_name") AS artist_norm, COUNT(*)::int AS plays
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE "entry_type" = 'track' AND "artist_name" IS NOT NULL
      GROUP BY 1
    ),
    library_artists AS (
      SELECT ${sql(SCHEMA)}.normalize_artist_name("artist_name") AS artist_norm FROM ${sql(SCHEMA)}.artists
      UNION
      SELECT ${sql(SCHEMA)}.normalize_artist_name("variant") FROM ${sql(SCHEMA)}.artist_search_alias
    )
    SELECT f."id" AS id, f."artist_name" AS artist_name, p.plays AS plays
    FROM ${sql(SCHEMA)}.flowsheet f
    JOIN plays p ON p.artist_norm = ${sql(SCHEMA)}.normalize_artist_name(f."artist_name")
    WHERE f."entry_type" = 'track'
      AND f."artist_name" IS NOT NULL
      AND f."metadata_attempt_at" IS NULL
      AND f."add_time" < now() - interval '60 seconds'
      AND f."artist_name" ILIKE '%bs1591%'
      ${eligibility}
    ORDER BY p.plays DESC, p.artist_norm ASC, f."id" ASC
  `;
}

describe('flowsheet-metadata-backfill work-list (real PG, BS#1591)', () => {
  let sql;
  const flowsheetIds = [];
  const artistIds = [];
  const libraryIds = [];

  /** Insert a flowsheet track row with an explicit add_time offset. */
  async function seedPlay(artist, { ageInterval = '30 days', albumId = null, stamped = false } = {}) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title,
         request_flag, segue, album_id, add_time, metadata_attempt_at)
      VALUES
        (98765, 'track', ${artist}, 'BS1591 Test Album', 'BS1591 Test Track',
         false, false, ${albumId}, now() - ${ageInterval}::interval,
         ${stamped ? sql`now()` : null})
      RETURNING id
    `;
    flowsheetIds.push(rows[0].id);
    return rows[0].id;
  }

  async function seedArtist(name) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${name}, ${name}, 'ZZ')
      RETURNING id
    `;
    artistIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    sql = getTestDb();

    // Non-library artists.
    for (let i = 0; i < 6; i += 1) await seedPlay('bs1591-highplay');
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1591-boosted');
    for (let i = 0; i < 4; i += 1) await seedPlay('bs1591-boosted', { stamped: true });
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1591-lowfreq');
    await seedPlay('bs1591-recent', { ageInterval: '1 hour' });

    // Library by catalog name — normalization must bridge the "The " prefix
    // and case difference between the flowsheet spelling and the card
    // catalog spelling.
    await seedArtist('BS1591-catalog-artist');
    await seedPlay('The bs1591-Catalog-Artist');

    // Library by alias variant — the canonical artists row has a DIFFERENT
    // name, so only the artist_search_alias arm can match this play.
    const aliasCanonicalId = await seedArtist('bs1591-alias-canonical');
    await sql`
      INSERT INTO ${sql(SCHEMA)}.artist_search_alias
        (artist_id, source, variant, method, confidence, last_verified_at)
      VALUES
        (${aliasCanonicalId}, 'discogs_name_variation', 'The BS1591-Alias-Variant', 'anv', 1.0, now())
    `;
    await seedPlay('bs1591-alias-variant');

    // Linked row — library by construction, no name match anywhere.
    const libraryRows = await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES
        (1, 11, 1, 'bs1591-worklist-test-album', 9871, 'Built to Spill')
      RETURNING id
    `;
    libraryIds.push(libraryRows[0].id);
    await seedPlay('bs1591-linked', { albumId: libraryRows[0].id });

    // Play-count tie between two library artists — pins the artist_norm
    // tiebreak that keeps same-artist rows contiguous.
    await seedArtist('bs1591-tie-a');
    await seedArtist('bs1591-tie-b');
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1591-tie-a');
    for (let i = 0; i < 2; i += 1) await seedPlay('bs1591-tie-b');
  });

  afterAll(async () => {
    if (flowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${flowsheetIds})`;
    }
    if (libraryIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
    }
    if (artistIds.length > 0) {
      // artist_search_alias rows cascade with their artist.
      await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ANY(${artistIds})`;
    }
  });

  it('orders eligible rows by plays DESC with artist_norm/id tiebreaks', async () => {
    const rows = await scopedWorkList(sql);
    const artistSequence = rows.map((r) => r.artist_name);

    expect(artistSequence).toEqual([
      // plays=6 tie → artist_norm ASC: boosted before highplay.
      'bs1591-boosted',
      'bs1591-boosted',
      'bs1591-highplay',
      'bs1591-highplay',
      'bs1591-highplay',
      'bs1591-highplay',
      'bs1591-highplay',
      'bs1591-highplay',
      // plays=2 tie → tie-a contiguous before tie-b (lowfreq, also plays=2,
      // is excluded by the floor — library membership decides the tie
      // group's fate).
      'bs1591-tie-a',
      'bs1591-tie-a',
      'bs1591-tie-b',
      'bs1591-tie-b',
      // plays=1 tie → artist_norm ASC ("The " stripped from the catalog
      // play before comparison).
      'bs1591-alias-variant',
      'The bs1591-Catalog-Artist',
      'bs1591-linked',
      'bs1591-recent',
    ]);

    // plays counts ALL rows (the 4 stamped bs1591-boosted plays), while the
    // work-list carries only the 2 pending ones.
    const boosted = rows.filter((r) => r.artist_name === 'bs1591-boosted');
    expect(boosted).toHaveLength(2);
    expect(boosted.every((r) => r.plays === 6)).toBe(true);

    // Within each artist group, ids ascend (the final tiebreak).
    const highplayIds = rows.filter((r) => r.artist_name === 'bs1591-highplay').map((r) => r.id);
    expect(highplayIds).toEqual([...highplayIds].sort((a, b) => a - b));
  });

  it('excludes below-floor non-library rows only — library, alias, linked, and recent rows survive the floor', async () => {
    const rows = await scopedWorkList(sql);
    const artists = new Set(rows.map((r) => r.artist_name));

    expect(artists.has('bs1591-lowfreq')).toBe(false);
    expect(artists.has('The bs1591-Catalog-Artist')).toBe(true);
    expect(artists.has('bs1591-alias-variant')).toBe(true);
    expect(artists.has('bs1591-linked')).toBe(true);
    expect(artists.has('bs1591-recent')).toBe(true);
  });

  it('satisfies the complement property: worklist + below-floor == pending (the subtraction identity)', async () => {
    const pendingTotal = await countScopedPending(sql);
    const workList = await scopedWorkList(sql);

    // The only excluded rows are bs1591-lowfreq's two plays.
    expect(pendingTotal - workList.length).toBe(2);
  });

  it('playFloor=0 disables the floor: every pending row is eligible (clause-omission shape, as production renders it)', async () => {
    // The mirror omits the eligibility clause entirely at floor 0 exactly
    // like production, so this executes the no-eligibility statement SHAPE
    // against real PG — a dangling AND after the omission would fail here.
    const pendingTotal = await countScopedPending(sql);
    const workList = await scopedWorkList(sql, { playFloor: 0 });

    expect(workList.length).toBe(pendingTotal);
  });

  it('recencyDays exemption is what saves the recent below-floor row (arm-omission shape, as production renders it)', async () => {
    // recencyDays=0 omits the recency arm from the disjunction (production's
    // conditional), so this both proves the recent row's eligibility came
    // from that arm AND executes the arm-omitted statement shape on real PG.
    const workList = await scopedWorkList(sql, { recencyDays: 0 });
    const artists = new Set(workList.map((r) => r.artist_name));

    expect(artists.has('bs1591-recent')).toBe(false);
  });
});
