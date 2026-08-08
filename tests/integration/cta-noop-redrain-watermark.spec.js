/**
 * BS#1991 (#801 S2) — pins the Postgres semantics that force
 * `writeCompilationTracks`'s app-side unchanged-row prefilter:
 * `touch_library_watermark_from_compilation_track_artist` (migration 0138)
 * is `FOR EACH STATEMENT`, so it fires — and advances `library_watermark` —
 * even when an UPDATE's `IS DISTINCT FROM` guard lets zero rows through.
 *
 * This spec issues the writer's exact chunked-UPDATE shape against a CTA row
 * that already carries the identical verdict, and asserts `UPDATE 0` +
 * watermark ADVANCED. That is the regression trap: if a future refactor
 * drops the app-side prefilter (writer.ts, `unchanged` check) believing the
 * SQL-level guard suffices, every no-op re-drain page bumps the watermark
 * and invalidates the catalog export's conditional-GET cache — ~12 CTA
 * statements per 100-release page over a full `RECHECK=true` V/A sweep with
 * nothing changed. (The per-batch `unresolved_attempted_at` stamp on
 * `library` used to be a separate, deliberate watermark touch that survived
 * this prefilter — `NOW()` is a genuine row change, so no app-side guard
 * could no-op it away. [BS#2052](https://github.com/WXYC/Backend-Service/issues/2052)
 * (migration 0142) closed that gap from the other side: the `library`
 * watermark trigger is now `UPDATE OF <exported columns>`, and
 * `unresolved_attempted_at` isn't exported, so the stamp no longer advances
 * `library_watermark` either. A fully-unchanged `--recheck` sweep is zero
 * watermark churn end to end — this spec's own CTA leg via the prefilter,
 * the `library` leg via 0142.)
 *
 * The complementary behavior — an unchanged page issues NO UPDATE statement
 * at all — lives at the unit tier ("issues NO UPDATE statement when every
 * matched row is already unchanged", writer.test.ts), because this tier is
 * pure SQL by convention (babel-jest runner, no TS import — see
 * cta-track-artist-link-cdc.spec.js). Together: unit proves the statement
 * isn't issued; this spec proves why it must not be.
 *
 * Pure SQL, same harness as cta-track-artist-link-cdc.spec.js.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) for a valid library_id FK.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;
const TEST_ARTIST = 'BS#1991 Noop Redrain Probe';
const TEST_TITLE = 'Statement Trigger Semantics';

describe('no-op CTA re-drain vs the FOR EACH STATEMENT watermark trigger (BS#1991)', () => {
  let sql;
  let artistId;
  let ctaId;

  beforeAll(async () => {
    sql = getTestDb();
    const artistRows = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${TEST_ARTIST}, ${TEST_ARTIST}, 'ZS')
      RETURNING id
    `;
    artistId = artistRows[0].id;
    const ctaRows = await sql`
      INSERT INTO ${sql(SCHEMA)}.compilation_track_artist
        (library_id, artist_name, track_title, track_position,
         track_artist_id, track_artist_link_confidence, track_artist_link_method)
      VALUES (${SHAPE_FIXTURE_LIBRARY_ID}, ${TEST_ARTIST}, ${TEST_TITLE}, 'A1', ${artistId}, 0.93, 'lml_backfill')
      RETURNING id
    `;
    ctaId = ctaRows[0].id;
  });

  afterAll(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.compilation_track_artist WHERE id = ${ctaId}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${artistId}`;
    await sql.end();
  });

  it('the writer-shaped UPDATE with an already-identical verdict changes 0 rows yet still advances the watermark', async () => {
    const before = await sql`SELECT last_modified_at FROM ${sql(SCHEMA)}.library_watermark`;
    // One tick so the strictly-greater assertion can't tie at JS millisecond
    // precision when the read and the trigger land inside the same ms.
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
    // UPDATE 0, watermark moved anyway — the FOR EACH STATEMENT reality the
    // app-side prefilter exists for.
    expect(new Date(after[0].last_modified_at).getTime()).toBeGreaterThan(
      new Date(before[0].last_modified_at).getTime()
    );
  });
});
