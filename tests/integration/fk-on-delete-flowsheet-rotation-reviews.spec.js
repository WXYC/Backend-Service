/**
 * FK ON DELETE behaviour on flowsheet / rotation / reviews
 * (WXYC/Backend-Service#1126, migration 0094).
 *
 * Five FK constraints drifted between the Drizzle schema source (SET NULL
 * for the three flowsheet FKs, CASCADE for rotation.album_id and
 * reviews.album_id) and the actual migration history (ON DELETE NO ACTION
 * via 0000_rare_prima.sql, recreated unchanged by 0016_nervous_hydra.sql).
 * Because the latest snapshot already records the schema-source values,
 * `drizzle-kit generate` produced no fix migration — the drift was
 * invisible to the normal authoring loop. Migration 0094 patches it.
 *
 * This spec is the live regression test: it asserts the current
 * `pg_constraint.confdeltype` for each of the five FKs (mirroring the
 * issue body's reproduction query) AND exercises the actual ON DELETE
 * behaviour via a parent-row DELETE under transaction rollback (so the
 * shape fixture loaded by globalSetup is not perturbed).
 *
 * If a future schema change re-introduces the drift, this spec fails
 * before the migration is ever attempted against prod.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

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

// Map from pg_constraint.confdeltype's single-char encoding to the SQL
// keyword we expect, for readable assertion failure messages.
const CONFDELTYPE_LABEL = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

describe('FK ON DELETE on flowsheet / rotation / reviews (#1126, migration 0094)', () => {
  let sql;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  test('pg_constraint.confdeltype matches the schema-source declarations', async () => {
    // The five FKs the migration repairs, with the action declared in
    // shared/database/src/schema.ts.
    const expectations = [
      { name: 'flowsheet_show_id_shows_id_fk', expected: 'n' }, // SET NULL
      { name: 'flowsheet_album_id_library_id_fk', expected: 'n' }, // SET NULL
      { name: 'flowsheet_rotation_id_rotation_id_fk', expected: 'n' }, // SET NULL
      { name: 'rotation_album_id_library_id_fk', expected: 'c' }, // CASCADE
      { name: 'reviews_album_id_library_id_fk', expected: 'c' }, // CASCADE
    ];

    // Constraint namespace is the per-worker schema (WXYC_SCHEMA_NAME). We
    // filter by both the constraint name and the namespace so a stale
    // constraint in `wxyc_schema` doesn't bleed into a worker schema's
    // assertions.
    const rows = await sql`
      SELECT c.conname, c.confdeltype
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = ${SCHEMA}
         AND c.conname = ANY (${sql.array(expectations.map((e) => e.name))})
    `;
    const observed = new Map(rows.map((r) => [r.conname, r.confdeltype]));

    for (const { name, expected } of expectations) {
      const actual = observed.get(name);
      expect({
        constraint: name,
        actual: `${actual ?? '(missing)'} (${CONFDELTYPE_LABEL[actual] ?? 'unknown'})`,
        expected: `${expected} (${CONFDELTYPE_LABEL[expected]})`,
      }).toEqual({
        constraint: name,
        actual: `${expected} (${CONFDELTYPE_LABEL[expected]})`,
        expected: `${expected} (${CONFDELTYPE_LABEL[expected]})`,
      });
    }
  });

  test('DELETE on a library row sets flowsheet.album_id to NULL (was NO ACTION)', async () => {
    // Run inside a transaction we abort, so the fixture stays intact for
    // any spec that runs after this one in the same Jest worker.
    await sql
      .begin(async (tx) => {
        // Insert a library row + a flowsheet entry referencing it. Use a
        // synthetic id well above the shape-fixture range (7000-7099) and
        // above the `bigserial`/`serial` PK floor for stability.
        const [lib] = await tx.unsafe(
          `INSERT INTO "${SCHEMA}".library (artist_name, album_title)
         VALUES ('FK Test Artist', 'FK Test Album')
         RETURNING id`
        );
        const [fls] = await tx.unsafe(
          `INSERT INTO "${SCHEMA}".flowsheet (album_id, entry_type, message)
         VALUES (${lib.id}, 'track', 'fk-test')
         RETURNING id`
        );

        await tx.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ${lib.id}`);

        const after = await tx.unsafe(`SELECT album_id FROM "${SCHEMA}".flowsheet WHERE id = ${fls.id}`);
        expect(after.length).toBe(1);
        expect(after[0].album_id).toBeNull();

        // Roll back so neither row survives the test.
        throw new Error('intentional rollback');
      })
      .catch((err) => {
        if (err.message !== 'intentional rollback') throw err;
      });
  });
});
