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
 * issue body's reproduction query) AND exercises each of the three
 * actual ON DELETE behaviours (flowsheet SET NULL, rotation CASCADE,
 * reviews CASCADE) via a parent-row DELETE under transaction rollback
 * (so the shape fixture loaded by globalSetup is not perturbed).
 *
 * If a future schema change re-introduces the drift, this spec fails
 * before the migration is ever attempted against prod.
 */

const { getTestDb, withRollback } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Map from pg_constraint.confdeltype's single-char encoding to the SQL
// keyword we expect, for readable assertion failure messages.
const CONFDELTYPE_LABEL = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

// Seeded baseline (dev_env/seed_db.sql): artists 1-3, genres 1-15
// (rock=11), formats include cd=1 / vinyl=2. The shape fixture
// (tests/fixtures/shape.sql) advances the library/rotation/flowsheet
// sequences to 7199 so any serial-assigned id below lands at 7200+,
// safely above the explicit-id fixture range (7000-7099). Each
// behavioural test wraps its INSERT/DELETE in a withRollback transaction
// so the fixture stays intact for downstream specs.
const SEED_ARTIST_ID = 1;
const SEED_GENRE_ID = 11;
const SEED_FORMAT_ID = 1;

describe('FK ON DELETE on flowsheet / rotation / reviews (#1126, migration 0094)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
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
    await withRollback(async (tx) => {
      // library: artist_id, genre_id, format_id, album_title, code_number
      // are all NOT NULL (see shared/database/src/schema.ts:344).
      // Let `serial` auto-assign id from the post-fixture sequence floor
      // (7200+); the explicit-id fixture range stops at 7099.
      const [lib] = await tx`
        INSERT INTO ${tx(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
        VALUES (${SEED_ARTIST_ID}, ${SEED_GENRE_ID}, ${SEED_FORMAT_ID},
                'FK Test Album SET NULL', 9001, 'FK Test Artist')
        RETURNING id
      `;
      // flowsheet: entry_type defaults to 'track'; play_order is NOT NULL
      // with no default (schema.ts:679).
      const [fls] = await tx`
        INSERT INTO ${tx(SCHEMA)}.flowsheet (album_id, entry_type, play_order, message)
        VALUES (${lib.id}, 'track', 1, 'fk-test-set-null')
        RETURNING id
      `;

      await tx`DELETE FROM ${tx(SCHEMA)}.library WHERE id = ${lib.id}`;

      const after = await tx`SELECT album_id FROM ${tx(SCHEMA)}.flowsheet WHERE id = ${fls.id}`;
      expect(after).toHaveLength(1);
      expect(after[0].album_id).toBeNull();
    });
  });

  test('DELETE on a library row cascades to rotation rows (was NO ACTION)', async () => {
    await withRollback(async (tx) => {
      const [lib] = await tx`
        INSERT INTO ${tx(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
        VALUES (${SEED_ARTIST_ID}, ${SEED_GENRE_ID}, ${SEED_FORMAT_ID},
                'FK Test Album CASCADE rotation', 9002, 'FK Test Artist')
        RETURNING id
      `;
      // rotation: album_id is nullable but referenced; rotation_bin is
      // NOT NULL (schema.ts:558).
      const [rot] = await tx`
        INSERT INTO ${tx(SCHEMA)}.rotation (album_id, rotation_bin)
        VALUES (${lib.id}, 'L')
        RETURNING id
      `;

      await tx`DELETE FROM ${tx(SCHEMA)}.library WHERE id = ${lib.id}`;

      const after = await tx`SELECT id FROM ${tx(SCHEMA)}.rotation WHERE id = ${rot.id}`;
      expect(after).toHaveLength(0);
    });
  });

  test('DELETE on a library row cascades to reviews rows (was NO ACTION)', async () => {
    await withRollback(async (tx) => {
      const [lib] = await tx`
        INSERT INTO ${tx(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
        VALUES (${SEED_ARTIST_ID}, ${SEED_GENRE_ID}, ${SEED_FORMAT_ID},
                'FK Test Album CASCADE reviews', 9003, 'FK Test Artist')
        RETURNING id
      `;
      // reviews: album_id is NOT NULL + UNIQUE (schema.ts:1075).
      const [rev] = await tx`
        INSERT INTO ${tx(SCHEMA)}.reviews (album_id, review, author)
        VALUES (${lib.id}, 'fk-test-cascade-reviews', 'fk-test')
        RETURNING id
      `;

      await tx`DELETE FROM ${tx(SCHEMA)}.library WHERE id = ${lib.id}`;

      const after = await tx`SELECT id FROM ${tx(SCHEMA)}.reviews WHERE id = ${rev.id}`;
      expect(after).toHaveLength(0);
    });
  });
});
