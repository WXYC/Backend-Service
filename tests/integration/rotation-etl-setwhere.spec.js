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
      discogs_release_id        = COALESCE(excluded.discogs_release_id, ${sql(SCHEMA)}.rotation.discogs_release_id),
      discogs_release_id_source = CASE
        WHEN excluded.discogs_release_id IS NOT NULL
          THEN 'tubafrenzy_paste'::${sql(SCHEMA)}.discogs_release_id_source_enum
        ELSE ${sql(SCHEMA)}.rotation.discogs_release_id_source
      END,
      -- BS#1380: drift-prevention CASE. Clears lml_identity_id only when
      -- tubafrenzy supplied a non-NULL discogs_release_id that differs
      -- from the persisted value. Mirrors jobs/rotation-etl/job.ts.
      lml_identity_id = CASE
        WHEN excluded.discogs_release_id IS NOT NULL
          AND excluded.discogs_release_id IS DISTINCT FROM ${sql(SCHEMA)}.rotation.discogs_release_id
          THEN NULL
        ELSE ${sql(SCHEMA)}.rotation.lml_identity_id
      END
    WHERE
      ${sql(SCHEMA)}.rotation.album_id                  IS DISTINCT FROM excluded.album_id OR
      ${sql(SCHEMA)}.rotation.legacy_library_release_id IS DISTINCT FROM excluded.legacy_library_release_id OR
      ${sql(SCHEMA)}.rotation.rotation_bin              IS DISTINCT FROM excluded.rotation_bin OR
      ${sql(SCHEMA)}.rotation.kill_date                 IS DISTINCT FROM excluded.kill_date OR
      ${sql(SCHEMA)}.rotation.artist_name               IS DISTINCT FROM excluded.artist_name OR
      ${sql(SCHEMA)}.rotation.album_title               IS DISTINCT FROM excluded.album_title OR
      ${sql(SCHEMA)}.rotation.record_label              IS DISTINCT FROM excluded.record_label OR
      (excluded.discogs_release_id IS NOT NULL
        AND ${sql(SCHEMA)}.rotation.discogs_release_id IS DISTINCT FROM excluded.discogs_release_id)
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

  // BS#1029 — load-bearing behavior. Without COALESCE, the 30-min rotation-etl
  // cron clobbers any value written by jobs/rotation-release-id-backfill on
  // its next tick (tubafrenzy's discogs_release_id column is empty for 100% of
  // prod rows, so excluded.discogs_release_id is NULL on every tick). This is
  // the regression that motivated the entire ticket.
  //
  // Tests below explicitly arrange the row state they need rather than
  // relying on the preceding test's residue — earlier tests in this file
  // share row state (the row inserted in test 1 carries forward), but
  // BS#1029's tests reset to a known shape so they can run in any order.
  test('COALESCE preserves a backfill-written id when tubafrenzy contributes NULL', async () => {
    // Arrange: simulate the backfill writing a release id with the
    // lml_offline_backfill source — what jobs/rotation-release-id-backfill
    // does.
    await sql`
      UPDATE ${sql(SCHEMA)}.rotation
      SET discogs_release_id = 999001,
          discogs_release_id_source = 'lml_offline_backfill'
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;

    // Act: the rotation-etl tick re-upserts with tubafrenzy's current shape:
    // discogs_release_id = NULL (the prod state today).
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
      SELECT discogs_release_id, discogs_release_id_source
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(after[0].discogs_release_id).toBe(999001);
    expect(after[0].discogs_release_id_source).toBe('lml_offline_backfill');
  });

  // BS#1029 — provenance correctness. After the backfill has populated a row,
  // a music director may still later paste a Discogs URL in tubafrenzy. The
  // MD-paste must win on both columns: the paste-URL wins the id, AND the
  // source flips so future readers know the value is now MD-verified.
  test('tubafrenzy paste overrides a backfill-written id and flips source', async () => {
    await sql`
      UPDATE ${sql(SCHEMA)}.rotation
      SET discogs_release_id = 999001,
          discogs_release_id_source = 'lml_offline_backfill'
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
      discogs_release_id: 888002,
    });
    const after = await sql`
      SELECT discogs_release_id, discogs_release_id_source
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(after[0].discogs_release_id).toBe(888002);
    expect(after[0].discogs_release_id_source).toBe('tubafrenzy_paste');
  });

  // BS#1029 — the setWhere gate. A tubafrenzy tick that contributes NULL
  // discogs_release_id over a backfill-written value should be a complete
  // no-op (no UPDATE, no CDC fire, xmin unchanged). Without gating the
  // IS DISTINCT FROM term on "excluded IS NOT NULL", COALESCE turns the
  // write into a value-no-op but the row still gets rewritten — wasting
  // a CDC event per row on every 30-min tick across all 310 active rows.
  // BS#1380 — drift-prevention CASE: when a tubafrenzy paste-correction
  // changes the discogs_release_id (Y_X is the LML identity minted against
  // the OLD discogs id; clearing it lets the daily backfill cron re-resolve
  // against X' on the next tick).
  test("paste-correction (X → X') of discogs_release_id clears lml_identity_id", async () => {
    // Arrange: pre-existing row at (discogs=X=999001, lml=Y_X=7700001).
    await sql`
      UPDATE ${sql(SCHEMA)}.rotation
      SET discogs_release_id = 999001,
          discogs_release_id_source = 'lml_offline_backfill',
          lml_identity_id = 7700001
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;

    // Act: tubafrenzy paste-correction supplies a new discogs_release_id.
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
      discogs_release_id: 999999,
    });

    const after = await sql`
      SELECT discogs_release_id, lml_identity_id, discogs_release_id_source
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(after[0].discogs_release_id).toBe(999999);
    expect(after[0].lml_identity_id).toBeNull();
    expect(after[0].discogs_release_id_source).toBe('tubafrenzy_paste');
  });

  // BS#1380 — regression test for the unguarded CASE: a tubafrenzy tick
  // that contributes NULL discogs_release_id but a changed kill_date
  // must NOT clear lml_identity_id. Without the
  // `excluded.discogs_release_id IS NOT NULL` guard, three-valued SQL
  // (NULL IS DISTINCT FROM X = TRUE) would null out a perfectly-good
  // identity on every kill_date / artist_name / etc. tick.
  test('NULL-upstream-with-other-change preserves lml_identity_id (drift CASE guard)', async () => {
    // Arrange: pre-existing row at (discogs=X=999001, lml=Y_X=7700001).
    await sql`
      UPDATE ${sql(SCHEMA)}.rotation
      SET discogs_release_id = 999001,
          discogs_release_id_source = 'lml_offline_backfill',
          lml_identity_id = 7700001,
          kill_date = NULL
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;

    // Act: tubafrenzy tick with NULL discogs_release_id but a kill_date
    // change. The discogs_release_id COALESCE preserves the persisted
    // value; without the guard, lml_identity_id would be nulled.
    await upsertRotationEtlShape(sql, {
      legacy_rotation_id: ROTATION_LEGACY_ID,
      legacy_library_release_id: 5550001,
      album_id: null,
      rotation_bin: 'H',
      add_date: '2026-05-24',
      kill_date: '2027-01-01', // changed; triggers setWhere gate
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      record_label: 'Drag City',
      discogs_release_id: null,
    });

    const after = await sql`
      SELECT discogs_release_id, lml_identity_id, kill_date
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(after[0].discogs_release_id).toBe(999001);
    expect(after[0].lml_identity_id).toBe(7700001);
    expect(after[0].kill_date.toISOString().slice(0, 10)).toBe('2027-01-01');
  });

  test('NULL excluded.discogs_release_id over a backfilled row is a xmin-quiet no-op', async () => {
    await sql`
      UPDATE ${sql(SCHEMA)}.rotation
      SET discogs_release_id = 999001,
          discogs_release_id_source = 'lml_offline_backfill'
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
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
      SELECT xmin::text AS xmin, discogs_release_id, discogs_release_id_source
      FROM ${sql(SCHEMA)}.rotation
      WHERE legacy_rotation_id = ${ROTATION_LEGACY_ID}
    `;
    expect(after[0].xmin).toBe(before[0].xmin);
    expect(after[0].discogs_release_id).toBe(999001);
    expect(after[0].discogs_release_id_source).toBe('lml_offline_backfill');
  });
});
