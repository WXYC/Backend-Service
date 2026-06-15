/**
 * BS#1429 — CHECK constraint `rotation_discogs_release_id_not_sentinel`
 * rejects `rotation.discogs_release_id = 0`.
 *
 * Discogs uses `0` nowhere in its real ID space; LML#518's caller-side
 * defense 422s on `id <= 0`. The 2026-05-29 bypass-LML operator rescue
 * landed 6 rows pinned to the `0` sentinel as a "we tried and failed"
 * placeholder — permanently unresolvable via the BS#1380 backfill and
 * the gap holding BS#1381 below the ≥99% coverage gate. The constraint
 * is a schema-level fence so any future operator rescue with the same
 * shape fails loudly at the DB layer.
 *
 * Spec covers:
 *   - INSERT with `discogs_release_id = 0` raises 23514 (check_violation).
 *   - INSERT with `discogs_release_id = NULL` succeeds (the normal
 *     "no Discogs handle yet" state for ~half of active rotation rows).
 *   - INSERT with `discogs_release_id = 12345` succeeds (regression
 *     coverage that the fence doesn't over-reject).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// High-entropy probe namespace so this spec doesn't collide with fixture
// rows or other tests sharing the per-worker schema. We INSERT with
// NULL album_id (FK is nullable; the 2005 zombie rows had this shape)
// so we don't need a library FK target.
const TEST_LEGACY_ROTATION_ID_BASE = 814290000;

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

describe('rotation_discogs_release_id_not_sentinel (BS#1429)', () => {
  let sql;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".rotation WHERE legacy_rotation_id >= $1 AND legacy_rotation_id < $2`, [
        TEST_LEGACY_ROTATION_ID_BASE,
        TEST_LEGACY_ROTATION_ID_BASE + 1000,
      ]);
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".rotation WHERE legacy_rotation_id >= $1 AND legacy_rotation_id < $2`, [
      TEST_LEGACY_ROTATION_ID_BASE,
      TEST_LEGACY_ROTATION_ID_BASE + 1000,
    ]);
  });

  test('INSERT with discogs_release_id = 0 is rejected with SQLSTATE 23514', async () => {
    let err;
    try {
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".rotation (legacy_rotation_id, rotation_bin, add_date, discogs_release_id)
         VALUES ($1, 'H', CURRENT_DATE, 0)`,
        [TEST_LEGACY_ROTATION_ID_BASE + 1]
      );
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    // SQLSTATE 23514 = check_violation.
    expect(err.code).toBe('23514');
    expect(err.constraint_name || err.constraint || '').toMatch(/rotation_discogs_release_id_not_sentinel/);

    const rows = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM "${SCHEMA}".rotation WHERE legacy_rotation_id = $1`, [
      TEST_LEGACY_ROTATION_ID_BASE + 1,
    ]);
    expect(rows[0].n).toBe(0);
  });

  test('INSERT with discogs_release_id = NULL succeeds', async () => {
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (legacy_rotation_id, rotation_bin, add_date, discogs_release_id)
       VALUES ($1, 'H', CURRENT_DATE, NULL)`,
      [TEST_LEGACY_ROTATION_ID_BASE + 2]
    );

    const rows = await sql.unsafe(`SELECT discogs_release_id FROM "${SCHEMA}".rotation WHERE legacy_rotation_id = $1`, [
      TEST_LEGACY_ROTATION_ID_BASE + 2,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].discogs_release_id).toBeNull();
  });

  test('INSERT with a real positive Discogs release id succeeds', async () => {
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (legacy_rotation_id, rotation_bin, add_date, discogs_release_id)
       VALUES ($1, 'H', CURRENT_DATE, 12345)`,
      [TEST_LEGACY_ROTATION_ID_BASE + 3]
    );

    const rows = await sql.unsafe(`SELECT discogs_release_id FROM "${SCHEMA}".rotation WHERE legacy_rotation_id = $1`, [
      TEST_LEGACY_ROTATION_ID_BASE + 3,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].discogs_release_id).toBe(12345);
  });

  test('UPDATE setting discogs_release_id to 0 is rejected', async () => {
    // Land a NULL row first, then attempt to UPDATE it to the sentinel —
    // catches a writer that synthesizes `0` post-insert as well as the
    // direct INSERT path.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (legacy_rotation_id, rotation_bin, add_date, discogs_release_id)
       VALUES ($1, 'H', CURRENT_DATE, NULL)`,
      [TEST_LEGACY_ROTATION_ID_BASE + 4]
    );

    let err;
    try {
      await sql.unsafe(`UPDATE "${SCHEMA}".rotation SET discogs_release_id = 0 WHERE legacy_rotation_id = $1`, [
        TEST_LEGACY_ROTATION_ID_BASE + 4,
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('23514');
    expect(err.constraint_name || err.constraint || '').toMatch(/rotation_discogs_release_id_not_sentinel/);

    const rows = await sql.unsafe(`SELECT discogs_release_id FROM "${SCHEMA}".rotation WHERE legacy_rotation_id = $1`, [
      TEST_LEGACY_ROTATION_ID_BASE + 4,
    ]);
    expect(rows[0].discogs_release_id).toBeNull();
  });
});
