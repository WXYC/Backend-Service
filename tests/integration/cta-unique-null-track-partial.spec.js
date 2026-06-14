/**
 * BS#1135 — `cta_unique_null_track_idx` partial unique closes the
 * NULL-track-title duplicate loophole.
 *
 * Postgres treats NULLs as distinct in unique B-tree comparisons by default,
 * which let `(library_id, artist_name, NULL track_title)` duplicates slip
 * past the original 0037 `cta_unique_idx`. Prod RDS runs PostgreSQL 14.22,
 * so the PG15+ `NULLS NOT DISTINCT` modifier isn't available; migration
 * 0099 adds a complementary partial unique index restricted to the
 * `track_title IS NULL` slice. The base index continues to enforce
 * uniqueness on the non-NULL slice.
 *
 * The schema-source drift guard lives at
 * `tests/unit/database/schema.cta-unique-null-track-partial.test.ts`. This spec is the
 * runtime behavior assertion: a second insert with the same
 * `(library_id, artist_name)` and a NULL `track_title` must be rejected by
 * the partial unique index.
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

describe('cta_unique_idx NULLS NOT DISTINCT (BS#1135)', () => {
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

  test('two rows with the same (library_id, artist_name) and NULL track_title are rejected', async () => {
    // First insert succeeds — the row defines the (library_id, artist_name,
    // NULL track_title) tuple the constraint should treat as taken.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".compilation_track_artist (library_id, artist_name, track_title)
       VALUES ($1, $2, NULL)`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
    );

    // Second insert with the same tuple must violate
    // cta_unique_null_track_idx. Before 0099 this would succeed because PG
    // treats NULLs as distinct in unique B-tree comparisons by default.
    // After 0099 the partial unique index over `track_title IS NULL`
    // rejects the duplicate.
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

    expect(err).toBeDefined();
    // Postgres SQLSTATE 23505 = unique_violation.
    expect(err.code).toBe('23505');
    expect(err.constraint_name || err.constraint || '').toMatch(/cta_unique_null_track_idx/);

    // And only the first row landed.
    const rows = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM "${SCHEMA}".compilation_track_artist
        WHERE library_id = $1 AND artist_name = $2 AND track_title IS NULL`,
      [SHAPE_FIXTURE_LIBRARY_ID, TEST_ARTIST]
    );
    expect(rows[0].n).toBe(1);
  });

  test('a NULL-track row coexists with a non-NULL-track row for the same (library_id, artist_name)', async () => {
    // The new partial unique covers only `track_title IS NULL`, so a row
    // with a non-NULL title sits outside the partial's slice and the base
    // 0037 `cta_unique_idx` handles it via standard non-NULL uniqueness.
    // This is exactly the loophole the migration closes for the NULL case
    // while preserving the original semantics for populated titles.
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
