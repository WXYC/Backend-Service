/**
 * BS#1991 (#801 S2) + BS#2054 — two independent guarantees about
 * `touch_library_watermark_from_compilation_track_artist`, pinned distinctly
 * because narrowing the trigger's UPDATE leg (migration 0143) changes what
 * the pre-BS#2054 version of this spec was proving.
 *
 * ORIGINAL SHAPE (pre-0143): the trigger was an unqualified `AFTER ... UPDATE
 * ...` (migration 0138), so ANY UPDATE statement against
 * `compilation_track_artist` fired it — including one whose `IS DISTINCT
 * FROM` guard let zero rows through. That's why `writeCompilationTracks`
 * needed its own app-side prefilter (`writer.ts`, the `unchanged` check):
 * without it, a fully-unchanged page would still issue an UPDATE statement,
 * and the STATEMENT-level trigger doesn't care that the statement changed
 * nothing.
 *
 * POST-0143: the trigger only watches `id`, `library_id`, `artist_name`,
 * `track_title` (see migration 0143's header for the derivation).
 * `writeCompilationTracks`'s batched UPDATE only ever sets `track_artist_id`,
 * `track_artist_link_confidence`, `track_artist_link_method`,
 * `track_position` — none of which are watched. So the writer's UPDATE now
 * NEVER advances the watermark, whether it changes 0 rows (a no-op re-drain)
 * or N rows (a first-time resolution — the "productive case" BS#2054's issue
 * called out as NOT covered by #1991's prefilter, because a genuine value
 * change is not something an app-side no-op guard suppresses). Below:
 *
 *   - "BS#1991" describes the STATEMENT-vs-ROW hazard the prefilter defends
 *     against, demonstrated against a column the trigger still watches
 *     (`artist_name`) — because after 0143 the writer's own four columns can
 *     no longer exhibit it against THIS trigger, but the underlying Postgres
 *     mechanism (`UPDATE OF` fires per statement, regardless of rows
 *     affected) is unchanged for whatever the trigger does watch, and the
 *     prefilter remains the only thing that would catch a future writer
 *     touching a watched column the same way.
 *   - "BS#2054" describes the new trigger-level guarantee, exercised against
 *     `applyCompilationWrites`'s actual SQL shape (`writer.ts`): neither the
 *     0-row case nor a genuine value change to the writer's four columns
 *     advances the watermark anymore. The simpler, column-by-column version
 *     of this guarantee (one column at a time, direct SQL, not tied to the
 *     writer's exact statement shape) lives in the dedicated
 *     `cta-watermark-narrow-scope.spec.js`, mirroring
 *     `library-watermark-narrow-scope.spec.js` for the `library` table.
 *
 * `UPDATE OF col` is target-list-based, not value-change-based — nothing
 * below claims the trigger only fires on real changes.
 *
 * CROSS-TIER: the complementary half of the BS#1991 guarantee — that an
 * unchanged page issues NO UPDATE statement at all — is pinned at the unit
 * tier ('issues NO UPDATE statement when every matched row is already
 * unchanged', tests/unit/jobs/library-identity-consumer/writer.test.ts),
 * because it is an assertion about what SQL the writer emits, not about what
 * the database does with it. Together: the unit test proves the statement
 * isn't issued; the BS#1991 block below proves why a statement-level trigger
 * makes that worth doing. Neither tier subsumes the other, and 0143 did not
 * retire either — don't delete one on the grounds that the other covers it.
 *
 * Pure SQL, same harness as cta-track-artist-link-cdc.spec.js.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) for a valid library_id FK.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;
const TEST_ARTIST = 'BS#1991 Noop Redrain Probe';
const TEST_TITLE = 'Statement Trigger Semantics';

describe('compilation_track_artist watermark trigger: two distinct guarantees (BS#1991 + BS#2054)', () => {
  let sql;
  let artistId;

  beforeAll(async () => {
    sql = getTestDb();
    const artistRows = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${TEST_ARTIST}, ${TEST_ARTIST}, 'ZS')
      RETURNING id
    `;
    artistId = artistRows[0].id;
  });

  afterAll(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.compilation_track_artist WHERE artist_name = ${TEST_ARTIST}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${artistId}`;
  });

  describe('BS#1991: FOR EACH STATEMENT fires on 0 rows for whatever the trigger DOES watch', () => {
    let ctaId;

    beforeEach(async () => {
      const ctaRows = await sql`
        INSERT INTO ${sql(SCHEMA)}.compilation_track_artist (library_id, artist_name, track_title)
        VALUES (${SHAPE_FIXTURE_LIBRARY_ID}, ${TEST_ARTIST}, ${TEST_TITLE})
        RETURNING id
      `;
      ctaId = ctaRows[0].id;
    });

    afterEach(async () => {
      await sql`DELETE FROM ${sql(SCHEMA)}.compilation_track_artist WHERE id = ${ctaId}`;
    });

    it('a 0-row UPDATE (IS DISTINCT FROM guard) against a watched column (artist_name) still advances the watermark', async () => {
      const before = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
      await sql`SELECT pg_sleep(0.002)`;

      // Same shape as applyCompilationWrites (VALUES join + IS DISTINCT FROM
      // guard), pointed at a column BS#2054 keeps watching — artist_name is
      // NOT one of the four columns writeCompilationTracks writes, so this is
      // a deliberately synthetic probe of the trigger mechanism in the
      // abstract, not a claim about what the real writer does today.
      const updated = await sql`
        UPDATE ${sql(SCHEMA)}.compilation_track_artist AS cta
        SET artist_name = v.artist_name
        FROM (VALUES (${ctaId}::int, ${TEST_ARTIST}::text)) AS v(id, artist_name)
        WHERE cta.id = v.id
          AND cta.artist_name IS DISTINCT FROM v.artist_name
        RETURNING cta.id
      `;
      expect(updated.length).toBe(0);

      const after = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
      expect(new Date(after[0].last_modified_at).getTime()).toBeGreaterThan(
        new Date(before[0].last_modified_at).getTime()
      );
    });
  });

  describe('BS#2054: the writer-shaped UPDATE never advances the watermark once its columns are excluded', () => {
    afterEach(async () => {
      // A failed expect() aborts the test body before its own inline DELETE
      // runs, so rely on this instead of per-test cleanup — otherwise a
      // legitimately-failing assertion (e.g. during the red phase of TDD)
      // leaves a row behind that collides with the next test's INSERT via
      // cta_unique_idx.
      await sql`DELETE FROM ${sql(SCHEMA)}.compilation_track_artist WHERE artist_name = ${TEST_ARTIST}`;
    });

    it('the writer-shaped UPDATE with an already-identical verdict changes 0 rows and does NOT advance the watermark', async () => {
      const ctaRows = await sql`
        INSERT INTO ${sql(SCHEMA)}.compilation_track_artist
          (library_id, artist_name, track_title, track_position,
           track_artist_id, track_artist_link_confidence, track_artist_link_method)
        VALUES (${SHAPE_FIXTURE_LIBRARY_ID}, ${TEST_ARTIST}, ${TEST_TITLE}, 'A1', ${artistId}, 0.93, 'lml_backfill')
        RETURNING id
      `;
      const ctaId = ctaRows[0].id;

      const before = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
      await sql`SELECT pg_sleep(0.002)`;

      // Verbatim shape of writer.ts applyCompilationWrites, one-row VALUES,
      // with values byte-identical to what the row already carries.
      const updated = await sql`
        UPDATE ${sql(SCHEMA)}.compilation_track_artist AS cta
        SET
          track_artist_id = v.track_artist_id,
          track_artist_link_confidence = v.confidence,
          track_artist_link_method = 'lml_backfill',
          track_position = COALESCE(v.position, cta.track_position)
        FROM (VALUES (${ctaId}::int, ${artistId}::int, 0.93::real, NULL::text)) AS v(id, track_artist_id, confidence, position)
        WHERE cta.id = v.id
          AND (
            cta.track_artist_id IS DISTINCT FROM v.track_artist_id
            OR cta.track_artist_link_confidence IS DISTINCT FROM v.confidence
            OR cta.track_artist_link_method IS DISTINCT FROM 'lml_backfill'
            OR cta.track_position IS DISTINCT FROM COALESCE(v.position, cta.track_position)
          )
        RETURNING cta.id
      `;
      expect(updated.length).toBe(0);

      const after = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
      expect(new Date(after[0].last_modified_at).getTime()).toEqual(new Date(before[0].last_modified_at).getTime());
    });

    it('the writer-shaped UPDATE resolving a first-time NULL -> value change updates the row and STILL does NOT advance the watermark', async () => {
      // The "productive case" from BS#2054's issue: track_artist_id NULL ->
      // resolved is a genuine change, so #1991's app-side no-op prefilter
      // would NOT have skipped queuing this row. Before 0143 this advanced
      // the watermark for a change no export surfaces; after 0143 it
      // structurally cannot, independent of any app-side filtering.
      const ctaRows = await sql`
        INSERT INTO ${sql(SCHEMA)}.compilation_track_artist (library_id, artist_name, track_title)
        VALUES (${SHAPE_FIXTURE_LIBRARY_ID}, ${TEST_ARTIST}, ${TEST_TITLE})
        RETURNING id
      `;
      const ctaId = ctaRows[0].id;

      const before = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
      await sql`SELECT pg_sleep(0.002)`;

      const updated = await sql`
        UPDATE ${sql(SCHEMA)}.compilation_track_artist AS cta
        SET
          track_artist_id = v.track_artist_id,
          track_artist_link_confidence = v.confidence,
          track_artist_link_method = 'lml_backfill',
          track_position = COALESCE(v.position, cta.track_position)
        FROM (VALUES (${ctaId}::int, ${artistId}::int, 0.93::real, 'A1'::text)) AS v(id, track_artist_id, confidence, position)
        WHERE cta.id = v.id
          AND (
            cta.track_artist_id IS DISTINCT FROM v.track_artist_id
            OR cta.track_artist_link_confidence IS DISTINCT FROM v.confidence
            OR cta.track_artist_link_method IS DISTINCT FROM 'lml_backfill'
            OR cta.track_position IS DISTINCT FROM COALESCE(v.position, cta.track_position)
          )
        RETURNING cta.id
      `;
      // A genuine change DID happen (unlike the no-op case above).
      expect(updated.length).toBe(1);

      const after = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
      expect(new Date(after[0].last_modified_at).getTime()).toEqual(new Date(before[0].last_modified_at).getTime());
    });
  });
});
