const postgres = require('postgres');

/**
 * Integration test for jobs/library-identity-consumer/select.ts's
 * `loadBatch` SELECT predicate (BS#1144 / BS#1800 follow-up).
 *
 * The prior unit-level coverage for this predicate string-matched
 * `/NOT EXISTS/` against the serialized Drizzle SQL object passed to a
 * mocked `db.execute` -- it could not distinguish the fixed predicate from
 * the pre-#1144 bug (`canonical_entity_id IS NOT NULL OR ...`, an
 * unconditional disjunct that also contains the substring "NOT EXISTS"
 * deeper in its OR branch), because a mocked db.execute never actually
 * evaluates the query against real rows. This spec replaces that with a
 * genuine behavioral fixture, run against a real Postgres:
 *
 *   - a canonicalized row with no library_identity row yet -> included
 *   - a canonicalized row whose library_identity row is FRESH -> excluded
 *   - a canonicalized row whose library_identity row is STALE -> included
 *   - a non-canonicalized row (canonical_entity_id IS NULL) -> excluded,
 *     regardless of identity freshness
 *
 * Coverage gap (deliberate, same shape as
 * tests/integration/library-identity-backfill.spec.js): we don't import
 * select.ts's `loadBatch` directly from this integration runner. The
 * integration runner uses babel-jest without TS support, and adding a
 * ts-jest transform crashes drizzle-orm's `extractTablesRelationalConfig` on
 * `gin_trgm_ops` indexes (see that file's docstring for the full crash
 * detail). `loadBatch`'s predicate-construction logic (env-var resolvers,
 * the flag-off/flag-on branch selection, the BS#1800 single-NOT-EXISTS
 * simplification's structural shape) is unit-tested against the mocked
 * `db.execute` in tests/unit/jobs/library-identity-consumer/select.test.ts.
 * This spec is the SQL-contract half: it embeds the flag-off predicate
 * literally and verifies its actual selection behavior against a real
 * database, so the two suites together cover both "the right SQL is built"
 * and "that SQL selects the right rows."
 *
 * Scoped to an isolated `wxyc_test_lib_id_sel_<random>` schema; dropped in
 * afterAll regardless of pass/fail.
 */
describe('library-identity-consumer loadBatch predicate (real DB, BS#1144/BS#1800)', () => {
  let sql;
  let schemaName;
  const staleDays = 7;

  beforeAll(async () => {
    schemaName = `wxyc_test_lib_id_sel_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
    });

    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    // Minimal standalone tables carrying only the columns the predicate
    // reads -- no FKs to artists/genres/format (irrelevant to this
    // predicate, and this is an isolated scratch schema, not the real
    // `library` table).
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".library (
        id integer PRIMARY KEY,
        artist_name text,
        canonical_entity_id text
      )
    `);
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".library_identity (
        library_id integer PRIMARY KEY,
        last_verified_at timestamptz NOT NULL,
        method text NOT NULL,
        confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1)
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

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE "${schemaName}".library, "${schemaName}".library_identity RESTART IDENTITY CASCADE`);
  });

  // The exact flag-off (INCLUDE_NULL_CANONICAL=false) predicate shape built
  // by jobs/library-identity-consumer/select.ts's loadBatch(), post-BS#1800
  // simplification: canonicalized AND no fresh library_identity row.
  const selectEligible = async () => {
    const rows = await sql.unsafe(
      `
      SELECT id
      FROM "${schemaName}".library
      WHERE artist_name IS NOT NULL
        AND canonical_entity_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "${schemaName}".library_identity li
          WHERE li.library_id = library.id
            AND li.last_verified_at >= NOW() - (interval '1 day' * $1)
        )
      ORDER BY id ASC
      `,
      [staleDays]
    );
    return rows.map((r) => r.id);
  };

  test('a canonicalized row with no library_identity row yet is included', async () => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, artist_name, canonical_entity_id) VALUES (1, 'Jessica Pratt', 'discogs:master:1')`
    );
    expect(await selectEligible()).toEqual([1]);
  });

  test('a canonicalized row with a FRESH library_identity row is excluded', async () => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, artist_name, canonical_entity_id) VALUES (2, 'Juana Molina', 'discogs:master:2')`
    );
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library_identity (library_id, last_verified_at, method, confidence) VALUES (2, NOW(), 'exact_match', 1.0)`
    );
    expect(await selectEligible()).toEqual([]);
  });

  test('a canonicalized row with a STALE library_identity row is included', async () => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, artist_name, canonical_entity_id) VALUES (3, 'Chuquimamani-Condori', 'discogs:master:3')`
    );
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library_identity (library_id, last_verified_at, method, confidence) VALUES (3, NOW() - interval '30 days', 'exact_match', 1.0)`
    );
    expect(await selectEligible()).toEqual([3]);
  });

  test('a non-canonicalized row is excluded regardless of identity freshness', async () => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, artist_name, canonical_entity_id) VALUES (4, 'Duke Ellington & John Coltrane', NULL)`
    );
    expect(await selectEligible()).toEqual([]);
  });

  test('mixed fixture: only the absent and stale rows are selected, never the fresh one', async () => {
    await sql.unsafe(`
      INSERT INTO "${schemaName}".library (id, artist_name, canonical_entity_id) VALUES
        (10, 'Jessica Pratt', 'discogs:master:10'),
        (11, 'Juana Molina', 'discogs:master:11'),
        (12, 'Chuquimamani-Condori', 'discogs:master:12')
    `);
    await sql.unsafe(`
      INSERT INTO "${schemaName}".library_identity (library_id, last_verified_at, method, confidence) VALUES
        (11, NOW(), 'exact_match', 1.0),
        (12, NOW() - interval '30 days', 'exact_match', 1.0)
    `);
    expect(await selectEligible()).toEqual([10, 12]);
  });
});
