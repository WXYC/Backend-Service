/**
 * PG-semantics pin for the rotation-etl setWhere (BS#1063). Hand-written
 * SQL mirrors jobs/rotation-etl/job.ts; the integration runner is
 * babel-jest and can't import drizzle-orm code.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const ROTATION_LEGACY_ID = 2000001063;

async function upsertRotationEtlShape(sql, row) {
  return sql`
    INSERT INTO ${sql(SCHEMA)}.rotation
      (legacy_rotation_id, legacy_library_release_id, album_id, rotation_bin,
       add_date, kill_date, artist_name, album_title, record_label,
       discogs_release_id)
    VALUES
      (${row.legacy_rotation_id}, ${row.legacy_library_release_id},
       ${row.album_id}, ${row.rotation_bin}, ${row.add_date}, ${row.kill_date},
       ${row.artist_name}, ${row.album_title}, ${row.record_label},
       ${row.discogs_release_id})
    ON CONFLICT (legacy_rotation_id) DO UPDATE SET
      album_id                  = excluded.album_id,
      legacy_library_release_id = excluded.legacy_library_release_id,
      rotation_bin              = excluded.rotation_bin,
      kill_date                 = excluded.kill_date,
      artist_name               = excluded.artist_name,
      album_title               = excluded.album_title,
      record_label              = excluded.record_label,
      discogs_release_id        = excluded.discogs_release_id
    WHERE
      ${sql(SCHEMA)}.rotation.album_id                  IS DISTINCT FROM excluded.album_id OR
      ${sql(SCHEMA)}.rotation.legacy_library_release_id IS DISTINCT FROM excluded.legacy_library_release_id OR
      ${sql(SCHEMA)}.rotation.rotation_bin              IS DISTINCT FROM excluded.rotation_bin OR
      ${sql(SCHEMA)}.rotation.kill_date                 IS DISTINCT FROM excluded.kill_date OR
      ${sql(SCHEMA)}.rotation.artist_name               IS DISTINCT FROM excluded.artist_name OR
      ${sql(SCHEMA)}.rotation.album_title               IS DISTINCT FROM excluded.album_title OR
      ${sql(SCHEMA)}.rotation.record_label              IS DISTINCT FROM excluded.record_label OR
      ${sql(SCHEMA)}.rotation.discogs_release_id        IS DISTINCT FROM excluded.discogs_release_id
  `;
}

describe('rotation-etl value-aware setWhere (BS#1063)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    await sql`
      DELETE FROM ${sql(SCHEMA)}.rotation WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  test('re-upserting an identical row produces no UPDATE (xmin unchanged)', async () => {
    const row = {
      legacy_rotation_id: ROTATION_LEGACY_ID,
      legacy_library_release_id: 5550001,
      album_id: null,
      rotation_bin: 'M',
      add_date: '2026-05-24',
      kill_date: null,
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      record_label: 'Drag City',
      discogs_release_id: null,
    };
    await upsertRotationEtlShape(sql, row);
    const before = await sql`
      SELECT xmin::text AS xmin
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(before.length).toBe(1);

    await upsertRotationEtlShape(sql, row);
    const after = await sql`
      SELECT xmin::text AS xmin
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(after[0].xmin).toBe(before[0].xmin);
  });

  test('re-upserting with one changed field produces an UPDATE (xmin changes)', async () => {
    const before = await sql`
      SELECT xmin::text AS xmin
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;

    await upsertRotationEtlShape(sql, {
      legacy_rotation_id: ROTATION_LEGACY_ID,
      legacy_library_release_id: 5550001,
      album_id: null,
      rotation_bin: 'H',
      add_date: '2026-05-24',
      kill_date: null,
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      record_label: 'Drag City',
      discogs_release_id: null,
    });
    const after = await sql`
      SELECT xmin::text AS xmin, rotation_bin
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(after[0].xmin).not.toBe(before[0].xmin);
    expect(after[0].rotation_bin).toBe('H');
  });

  test('NULL → integer transition fires an UPDATE (IS DISTINCT FROM semantics)', async () => {
    // discogs_release_id is nullable. The plain `=` predicate would yield
    // NULL on a NULL → integer transition and skip the UPDATE — silently
    // dropping the new value. IS DISTINCT FROM is the right operator.
    const before = await sql`
      SELECT xmin::text AS xmin, discogs_release_id
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(before[0].discogs_release_id).toBeNull();

    await upsertRotationEtlShape(sql, {
      legacy_rotation_id: ROTATION_LEGACY_ID,
      legacy_library_release_id: 5550001,
      album_id: null,
      rotation_bin: 'H',
      add_date: '2026-05-24',
      kill_date: null,
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      record_label: 'Drag City',
      discogs_release_id: 123456,
    });
    const after = await sql`
      SELECT xmin::text AS xmin, discogs_release_id
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(after[0].xmin).not.toBe(before[0].xmin);
    expect(after[0].discogs_release_id).toBe(123456);
  });
});
