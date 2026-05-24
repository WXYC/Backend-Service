/**
 * Integration test for `jobs/flowsheet-etl/job.ts` value-aware setWhere
 * predicate on `runIncremental`'s `onConflictDoUpdate` (BS#1059 / parent
 * BS#1058).
 *
 * Background: tubafrenzy's mirror code bumps `TIME_LAST_MODIFIED` on adjacent
 * rows during normal operation (flowsheet.mirror.ts close-prior-now-playing
 * UPDATE). `fetchLegacyEntries(sinceMs)` therefore re-emits rows whose
 * display fields haven't actually changed. Without value-aware setWhere,
 * the upsert generated a dead tuple on every such re-emit — defeating HOT
 * (every set-list column is indexed) and exploding the index/heap ratio.
 *
 * This spec pins the PG-side semantics: an upsert whose `excluded.*` values
 * all match the existing row produces ZERO heap writes. The spec uses a
 * `xmin`-on-row signal — `xmin` is the inserting transaction id and changes
 * iff the row was UPDATEd (HOT or not). It does NOT depend on the lagging
 * `pg_stat_user_tables.n_tup_upd` counter (which the ticket suggested but
 * which lags via the stats collector); xmin is row-local and immediate.
 *
 * The companion unit test at
 * `tests/unit/jobs/flowsheet-etl/job.test.ts` (`passes setWhere on every
 * onConflictDoUpdate call`) pins the shape — that the ETL passes `setWhere`
 * on every conflict path. This spec pins the wire semantics — that the
 * predicate actually behaves as expected against real Postgres.
 *
 * Pure SQL — does NOT import the ETL code (the integration runner is
 * babel-jest with no TS support; see `flowsheet-etl-cdc-delivery.spec.js`
 * header for the drizzle-orm + ts-jest incompatibility). The SQL shape
 * mirrors `jobs/flowsheet-etl/job.ts:397-444`; if it drifts the unit test
 * fires first.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Emit the ETL-shape upsert with the value-aware setWhere predicate.
 * Mirrors `jobs/flowsheet-etl/job.ts:397-444`. Returns the affected row count
 * (postgres-js exposes this on the result object).
 */
async function upsertEtlShape(sql, row) {
  return sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (legacy_entry_id, entry_type, artist_name, album_title, track_title,
       record_label, message, request_flag, segue, play_order, add_time)
    VALUES
      (${row.legacy_entry_id}, ${row.entry_type}, ${row.artist_name},
       ${row.album_title}, ${row.track_title}, ${row.record_label},
       ${row.message}, ${row.request_flag}, ${row.segue}, ${row.play_order},
       ${row.add_time})
    ON CONFLICT (legacy_entry_id) DO UPDATE SET
      artist_name = excluded.artist_name,
      album_title = excluded.album_title,
      track_title = excluded.track_title,
      record_label = excluded.record_label,
      message = excluded.message,
      request_flag = excluded.request_flag,
      segue = excluded.segue,
      entry_type = excluded.entry_type,
      add_time = excluded.add_time,
      play_order = excluded.play_order
    WHERE
      ${sql(SCHEMA)}.flowsheet.artist_name IS DISTINCT FROM excluded.artist_name OR
      ${sql(SCHEMA)}.flowsheet.album_title IS DISTINCT FROM excluded.album_title OR
      ${sql(SCHEMA)}.flowsheet.track_title IS DISTINCT FROM excluded.track_title OR
      ${sql(SCHEMA)}.flowsheet.record_label IS DISTINCT FROM excluded.record_label OR
      ${sql(SCHEMA)}.flowsheet.message IS DISTINCT FROM excluded.message OR
      ${sql(SCHEMA)}.flowsheet.request_flag IS DISTINCT FROM excluded.request_flag OR
      ${sql(SCHEMA)}.flowsheet.segue IS DISTINCT FROM excluded.segue OR
      ${sql(SCHEMA)}.flowsheet.entry_type IS DISTINCT FROM excluded.entry_type OR
      ${sql(SCHEMA)}.flowsheet.add_time IS DISTINCT FROM excluded.add_time OR
      ${sql(SCHEMA)}.flowsheet.play_order IS DISTINCT FROM excluded.play_order
  `;
}

describe('flowsheet-etl value-aware setWhere (BS#1059)', () => {
  let sql;
  const insertedLegacyIds = [];

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (insertedLegacyIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE legacy_entry_id = ANY(${insertedLegacyIds})`;
    }
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  test('re-upserting an identical row produces no UPDATE (xmin unchanged)', async () => {
    // Insert a fresh row, capture its xmin (the inserting xact id).
    const legacyId = 2000001059;
    insertedLegacyIds.push(legacyId);
    const row = {
      legacy_entry_id: legacyId,
      entry_type: 'track',
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
      record_label: 'Sonamos',
      message: null,
      request_flag: false,
      segue: false,
      play_order: 99001,
      add_time: new Date('2026-05-24T12:00:00Z'),
    };
    await upsertEtlShape(sql, row);
    const before = await sql`
      SELECT xmin::text AS xmin
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;
    expect(before.length).toBe(1);

    // Re-emit the SAME row. With the setWhere predicate, every IS DISTINCT
    // FROM evaluates to FALSE, the UPDATE branch is skipped, and the heap
    // tuple is not rewritten. xmin therefore stays at the insert's xid.
    await upsertEtlShape(sql, row);
    const after = await sql`
      SELECT xmin::text AS xmin
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;
    expect(after[0].xmin).toBe(before[0].xmin);
  });

  test('re-upserting with one changed field produces an UPDATE (xmin changes)', async () => {
    // Independent row from the previous test so the suite stays order-
    // independent. (Jest --runInBand runs in declared order locally but the
    // CI runner shouldn't have to know that.)
    const legacyId = 2000001060;
    insertedLegacyIds.push(legacyId);
    const row = {
      legacy_entry_id: legacyId,
      entry_type: 'track',
      artist_name: 'Jessica Pratt',
      album_title: 'On Your Own Love Again',
      track_title: 'Back, Baby',
      record_label: 'Drag City',
      message: null,
      request_flag: false,
      segue: false,
      play_order: 99002,
      add_time: new Date('2026-05-24T12:30:00Z'),
    };
    await upsertEtlShape(sql, row);
    const before = await sql`
      SELECT xmin::text AS xmin
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;

    // Re-emit with album_title changed. The setWhere predicate's
    // album_title-leg matches, the UPDATE fires, xmin advances.
    await upsertEtlShape(sql, { ...row, album_title: 'On Your Own Love Again (Remastered)' });
    const after = await sql`
      SELECT xmin::text AS xmin, album_title
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;
    expect(after[0].xmin).not.toBe(before[0].xmin);
    expect(after[0].album_title).toBe('On Your Own Love Again (Remastered)');
  });

  test('setWhere predicate treats NULL transitions as distinct (NULL → string fires UPDATE)', async () => {
    // IS DISTINCT FROM is the right operator for nullable columns: it
    // returns TRUE when one side is NULL and the other is not. The plain
    // `=` operator would yield NULL, which the WHERE clause treats as
    // FALSE — and an edit that set artist_name from NULL to "Sessa" would
    // silently fail to propagate. Pin the contract here.
    const legacyId = 2000001061;
    insertedLegacyIds.push(legacyId);
    const row = {
      legacy_entry_id: legacyId,
      entry_type: 'track',
      artist_name: null,
      album_title: null,
      track_title: null,
      record_label: null,
      message: null,
      request_flag: false,
      segue: false,
      play_order: 99003,
      add_time: new Date('2026-05-24T13:00:00Z'),
    };
    await upsertEtlShape(sql, row);
    const before = await sql`
      SELECT xmin::text AS xmin
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;

    await upsertEtlShape(sql, { ...row, artist_name: 'Chuquimamani-Condori' });
    const after = await sql`
      SELECT xmin::text AS xmin, artist_name
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;
    expect(after[0].xmin).not.toBe(before[0].xmin);
    expect(after[0].artist_name).toBe('Chuquimamani-Condori');
  });
});
