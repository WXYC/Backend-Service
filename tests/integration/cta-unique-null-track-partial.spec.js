/**
 * BS#1135 (superseded by BS#1990 / #801 S1 — read to the end before editing).
 *
 * Postgres treats NULLs as distinct in unique B-tree comparisons by default,
 * which let `(library_id, artist_name, NULL track_title)` duplicates slip
 * past the original 0037 `cta_unique_idx`. Prod RDS runs PostgreSQL 14.22,
 * so the PG15+ `NULLS NOT DISTINCT` modifier isn't available; migration
 * 0099 added a complementary partial unique index (`cta_unique_null_track_idx`)
 * restricted to the `track_title IS NULL` slice.
 *
 * BS#1990's S0/#1989 prod audit re-ran 0099's own precondition count —
 * duplicate `(library_id, artist_name)` groups with a NULL `track_title` —
 * and measured ZERO rows. The partial index was protecting an empty slice,
 * pure write-tax on every CTA insert with a NULL track_title, so migration
 * 0139 DROPs it. This spec now asserts the post-drop behavior: duplicate
 * `(library_id, artist_name, NULL track_title)` rows are ALLOWED again. The
 * base `cta_unique_idx` (0037) is untouched and still enforces uniqueness on
 * the non-NULL `track_title` slice — see the second test below.
 *
 * The schema-source drift guard lives at
 * `tests/unit/database/schema.cta-unique-null-track-partial.test.ts` (the
 * "schema.ts no longer declares it" assertion) and
 * `tests/unit/database/schema.cta-track-artist-link.test.ts` (the 0139
 * migration-source assertions).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) so we don't have to seed a
// new library row to satisfy the FK. The fixture lives in
// `tests/fixtures/shape.sql`; the migrations.spec.js sanity test asserts
// it loaded.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;

// Use a high-entropy artist_name string so this spec doesn't collide with
// fixture rows or other tests running against the same per-worker schema.
// The fixture's BS#819 CTA seed uses artist names like
// 'Shape Fixture Comp Guest Alpha' — none with NULL track_title — so we're
// safe to insert NULL-track rows under our own artist namespace.
const TEST_ARTIST = 'BS#1135 Null-Track Constraint Probe';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('cta_unique_null_track_idx dropped (BS#1990 / #801 S1, was BS#1135)', () => {
  let sql;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) {
      // Clean our probe rows so a re-run on the same DB is idempotent.
      await sql.unsafe(`DELETE FROM "${SCHEMA}".compilation_track_artist WHERE artist_name = $1`, [TEST_ARTIST]);
      await sql.end();
    }
  });

  beforeEach(async () => {
    // Per-test isolation — clear any leftover rows under our artist
    // namespace before exercising the constraint.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".compilation_track_artist WHERE artist_name = $1`, [TEST_ARTIST]);
  });

  test('two rows with the same (library_id, artist_name) and NULL track_title are now ALLOWED (0099 index dropped by 0139)', async () => {
    // Before migration 0139, the second insert below would violate
    // cta_unique_null_track_idx (BS#1135 / 0099). The S0/#1989 prod audit
    // measured zero rows in the slice that index protected, so BS#1990's
    // migration 0139 drops it — both inserts must now succeed.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title)
       VALUES ($1, $2, NULL)`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
    );

    let err;
    try {
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title)
         VALUES ($1, $2, NULL)`,
        [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
      );
    } catch (e) {
      err = e;
    }

    expect(err).toBeUndefined();

    // Both rows landed — the base cta_unique_idx (0037) doesn't block this
    // either, since it treats NULL track_title values as distinct (the
    // exact loophole 0099 used to close and 0139 re-opens on purpose).
    const rows = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM "${SCHEMA}".compilation_track_artist
        WHERE library_id = $1 AND artist_name = $2 AND track_title IS NULL`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
    );
    expect(rows[0].n).toBe(2);
  });

  test('a NULL-track row coexists with a non-NULL-track row for the same (library_id, artist_name)', async () => {
    // Regression guard for cta_unique_idx (0037), unaffected by the 0139
    // drop: a populated track_title is a distinct tuple from a NULL one, so
    // both rows are legitimate under the base unique index regardless of
    // whether the (now-dropped) NULL-track partial index exists.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title)
       VALUES ($1, $2, NULL)`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title)
       VALUES ($1, $2, 'Some Track Title')`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
    );

    const rows = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM "${SCHEMA}".compilation_track_artist
        WHERE library_id = $1 AND artist_name = $2`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
    );
    expect(rows[0].n).toBe(2);
  });
});
