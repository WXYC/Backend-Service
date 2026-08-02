/**
 * PG-semantics pin for the value-aware setWhere on `runIncremental`'s
 * onConflictDoUpdate (BS#1059). Mirrors the SQL shape at
 * `jobs/flowsheet-etl/job.ts:397-458` by hand because the integration
 * runner is babel-jest and can't import the ETL's drizzle-orm code (see
 * `flowsheet-etl-cdc-delivery.spec.js` header for the same constraint).
 *
 * Uses xmin rather than `pg_stat_user_tables.n_tup_upd` because xmin is
 * row-local and immediate; n_tup_upd lags via the stats collector.
 *
 * `request_flag` / `segue` are intentionally OMITTED from this shape's SET
 * list and `setWhere` guard (BS#1857 / BS#1623): a live show's flags are
 * authoritatively owned by BS's DJ-facing PATCH /flowsheet, and a blind
 * re-sync refresh from tubafrenzy's copy could revert a DJ's toggle. They
 * stay in the INSERT column list / VALUES below so a brand-new tubafrenzy
 * entry still gets its flags on first sync — see the dedicated re-sync
 * survival test at the bottom of this file.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

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
      entry_type = excluded.entry_type,
      add_time = excluded.add_time,
      play_order = excluded.play_order
    WHERE
      ${sql(SCHEMA)}.flowsheet.artist_name IS DISTINCT FROM excluded.artist_name OR
      ${sql(SCHEMA)}.flowsheet.album_title IS DISTINCT FROM excluded.album_title OR
      ${sql(SCHEMA)}.flowsheet.track_title IS DISTINCT FROM excluded.track_title OR
      ${sql(SCHEMA)}.flowsheet.record_label IS DISTINCT FROM excluded.record_label OR
      ${sql(SCHEMA)}.flowsheet.message IS DISTINCT FROM excluded.message OR
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

    await upsertEtlShape(sql, row);
    const after = await sql`
      SELECT xmin::text AS xmin
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;
    expect(after[0].xmin).toBe(before[0].xmin);
  });

  test('re-upserting with one changed field produces an UPDATE (xmin changes)', async () => {
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

  // BS#1857 / BS#1623: request_flag / segue must NOT be reverted by a
  // tubafrenzy re-sync once a DJ has toggled them in BS. A brand-new entry
  // must still receive its flags on first sync (INSERT path unaffected).
  test('a re-sync with a differing request_flag/segue in the incoming payload does not revert the stored value', async () => {
    const legacyId = 2000001623;
    insertedLegacyIds.push(legacyId);
    const row = {
      legacy_entry_id: legacyId,
      entry_type: 'track',
      artist_name: 'Duke Ellington & John Coltrane',
      album_title: 'Duke Ellington & John Coltrane',
      track_title: 'In a Sentimental Mood',
      record_label: 'Impulse Records',
      message: null,
      request_flag: false,
      segue: false,
      play_order: 99004,
      add_time: new Date('2026-05-24T14:00:00Z'),
    };
    // First sync: brand-new tubafrenzy entry, flags false on INSERT.
    await upsertEtlShape(sql, row);

    // A DJ toggles both flags on in BS (out of band — mirrors PATCH /flowsheet's
    // direct UPDATE, not the ETL upsert shape under test).
    await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet
      SET request_flag = true, segue = true
      WHERE legacy_entry_id = ${legacyId}
    `;

    // tubafrenzy's copy still carries the stale pre-toggle flags (false).
    // Re-syncing with a differing album_title (so the setWhere guard fires
    // an UPDATE at all) must NOT drag request_flag/segue back to false.
    await upsertEtlShape(sql, { ...row, album_title: 'Duke Ellington & John Coltrane (Remastered)' });

    const after = await sql`
      SELECT album_title, request_flag, segue
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;
    expect(after[0].album_title).toBe('Duke Ellington & John Coltrane (Remastered)');
    expect(after[0].request_flag).toBe(true);
    expect(after[0].segue).toBe(true);
  });

  test('a brand-new entry still receives request_flag/segue from tubafrenzy on first sync', async () => {
    const legacyId = 2000001624;
    insertedLegacyIds.push(legacyId);
    const row = {
      legacy_entry_id: legacyId,
      entry_type: 'track',
      artist_name: 'Chuquimamani-Condori',
      album_title: 'Edits',
      track_title: 'Call Your Name',
      record_label: 'self-released',
      message: null,
      request_flag: true,
      segue: true,
      play_order: 99005,
      add_time: new Date('2026-05-24T14:30:00Z'),
    };
    await upsertEtlShape(sql, row);

    const rows = await sql`
      SELECT request_flag, segue
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE legacy_entry_id = ${legacyId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].request_flag).toBe(true);
    expect(rows[0].segue).toBe(true);
  });
});
