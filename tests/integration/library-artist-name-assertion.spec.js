const postgres = require('postgres');

/**
 * Real-DB integration test for the catalog-search precondition assertion.
 *
 * Validates the SQL contract that
 * `apps/backend/services/library-artist-name-assertion.service.ts:runCheck`
 * depends on, against a real Postgres rather than the @wxyc/database mock the
 * unit tests use:
 *
 *   - The exact query
 *     `SELECT count(*)::int AS n FROM library WHERE artist_name IS NULL LIMIT 1`
 *     parses, executes, and returns the expected `{ n: number }` shape.
 *   - It correctly reports a non-zero count when artist_name is NULL.
 *   - It returns 0 once the column is fully populated.
 *
 * The assertion's JS-side behavior (caching, error class, gating wiring) is
 * covered by `tests/unit/services/library-artist-name-assertion.test.ts`.
 *
 * The test runs against the same Postgres the integration suite uses but
 * inside an isolated `wxyc_test_assertion_<random>` schema so it cannot
 * collide with seeded data or other in-flight tests. The schema is dropped
 * in afterAll regardless of pass/fail.
 */
describe('library-artist-name-assertion (real DB)', () => {
  let sql;
  let schemaName;

  beforeAll(async () => {
    schemaName = `wxyc_test_assertion_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
    });

    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".library (
        id serial PRIMARY KEY,
        artist_name varchar,
        album_title varchar
      )
    `);
  });

  afterAll(async () => {
    if (sql) {
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await sql.end();
      }
    }
  });

  // The exact predicate the assertion uses; kept in sync with
  // `library-artist-name-assertion.service.ts`.
  const runAssertionQuery = () =>
    sql.unsafe(`SELECT count(*)::int AS n FROM "${schemaName}".library WHERE artist_name IS NULL LIMIT 1`);

  test('returns 0 against an empty table (vacuous pass)', async () => {
    const rows = await runAssertionQuery();
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(0);
  });

  test('reports a non-zero count when artist_name has any NULL row', async () => {
    await sql.unsafe(`INSERT INTO "${schemaName}".library (artist_name, album_title) VALUES (NULL, 'pre-backfill')`);
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (artist_name, album_title) VALUES ('Stereolab', 'Aluminum Tunes')`
    );

    const rows = await runAssertionQuery();
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(1);
  });

  test('returns 0 once every row has artist_name populated (post-backfill)', async () => {
    await sql.unsafe(`UPDATE "${schemaName}".library SET artist_name = 'Backfilled' WHERE artist_name IS NULL`);

    const rows = await runAssertionQuery();
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(0);
  });

  test('count returns as a numeric — not a stringified bigint — under count(*)::int', async () => {
    // The assertion casts to `int` specifically so postgres-js doesn't return
    // `bigint` as a string; the unit tests cover the string-fallback path
    // defensively, but verifying the typed result here documents the contract.
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (artist_name, album_title) VALUES (NULL, 'post-backfill-regression')`
    );
    const rows = await runAssertionQuery();
    expect(typeof rows[0].n).toBe('number');
  });
});
