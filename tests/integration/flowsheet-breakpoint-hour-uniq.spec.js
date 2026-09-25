/**
 * Integration test: the `flowsheet_show_radio_hour_breakpoint_idx` partial
 * unique index (BS#2569), against real Postgres.
 *
 * The schema-source spec
 * (`tests/unit/database/schema.flowsheet-breakpoint-hour-uniq.test.ts`)
 * asserts the migration says the right thing. This one asserts Postgres
 * actually DOES it — which the unit tier cannot, because the unit suite
 * resolves `@wxyc/database` to a hand-written mock with no constraint engine.
 *
 * Two halves, and the second is the one worth the file:
 *
 *   1. The index rejects a duplicate (show_id, radio_hour) breakpoint, and
 *      the bare `ON CONFLICT DO NOTHING` both live writers use converts that
 *      rejection into a suppressed no-op rather than a raise. That pairing is
 *      the whole deploy-order argument of BS#2569 — the fill
 *      (`flowsheet.service.ts`, a269b724) and the tubafrenzy webhook
 *      (`internal.route.ts`) each rely on it to stay 200 in front of a live
 *      DJ, and neither is exercised against a real constraint anywhere else.
 *
 *   2. The index is genuinely PARTIAL. Each predicate leg gets its own test,
 *      because an over-broad index here is far worse than a missing one: it
 *      would start rejecting ordinary track rows mid-show. A unique index on
 *      (show_id, radio_hour) alone would break test 4; one missing the
 *      `radio_hour IS NOT NULL` leg would break test 5.
 *
 * Fresh rows only, cleaned up by their show_name prefix — no fixed-id
 * assumptions (local dev DB volumes persist and drift).
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const NAME_PREFIX = 'bs2569:';
const HOUR = '2099-03-01 15:00:00+00';
const OTHER_HOUR = '2099-03-01 16:00:00+00';
// Owned solely by the ON CONFLICT test, so it seeds and collides in one case.
const CONFLICT_HOUR = '2099-03-01 17:00:00+00';

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

describe('flowsheet breakpoint hour uniqueness (BS#2569)', () => {
  let sql;
  let showA;
  let showB;

  /** Insert one flowsheet row, mirroring the fill's column set. */
  const insertRow = (showId, entryType, radioHour, conflictClause = sql.unsafe('')) => sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (show_id, entry_type, artist_name, album_title, track_title, message, radio_hour, play_order)
    VALUES (
      ${showId}, ${entryType}, '', '', '',
      ${'BS2569 probe'}, ${radioHour}::timestamptz, ${0}
    )
    ${conflictClause}
    RETURNING id`;

  beforeAll(async () => {
    sql = makeSql();
    const mkShow = async (suffix) => {
      const [row] = await sql`
        INSERT INTO ${sql(SCHEMA)}.shows (show_name, start_time, end_time)
        VALUES (${NAME_PREFIX + suffix}, ${'2099-03-01 14:00:00+00'}::timestamptz, NULL)
        RETURNING id`;
      return row.id;
    };
    showA = await mkShow('a');
    showB = await mkShow('b');
  });

  afterAll(async () => {
    if (!sql) return;
    // flowsheet rows first — they FK to shows.
    await sql`
      DELETE FROM ${sql(SCHEMA)}.flowsheet
      WHERE show_id IN (
        SELECT id FROM ${sql(SCHEMA)}.shows WHERE show_name LIKE ${NAME_PREFIX + '%'}
      )`;
    await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE show_name LIKE ${NAME_PREFIX + '%'}`;
    await sql.end();
  });

  test('the index exists and is a valid unique index', async () => {
    // Without this the rejection tests below could pass for the wrong reason
    // (e.g. some other constraint), and the permissive tests would pass
    // vacuously on a database where the index was never created.
    // Scoped to THIS schema on purpose: the suite gives each Jest worker its
    // own schema via WXYC_SCHEMA_NAME, so more than one can carry an index of
    // this name and a bare relname filter would assert against whichever row
    // came back first.
    const [row] = await sql`
      SELECT i.indisunique, i.indisvalid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.relname = 'flowsheet_show_radio_hour_breakpoint_idx'
        AND n.nspname = ${SCHEMA}`;
    expect(row).toBeDefined();
    expect(row.indisunique).toBe(true);
    expect(row.indisvalid).toBe(true);
  });

  test('rejects a second breakpoint claiming the same hour of the same show', async () => {
    await insertRow(showA, 'breakpoint', HOUR);
    await expect(insertRow(showA, 'breakpoint', HOUR)).rejects.toMatchObject({ code: '23505' });
  });

  test('ON CONFLICT DO NOTHING suppresses the collision instead of raising', async () => {
    // This is the shape `fillMissingHourlyBreakpoints` (a269b724) and the
    // tubafrenzy webhook both use — untargeted, so it catches THIS index and
    // not merely the legacy_entry_id one. RETURNING comes back empty, which is
    // exactly why the fill counts `inserted.length` rather than
    // `missing.length`: the caller broadcasts a refetch only for markers that
    // were actually committed (BS#2621).
    // Seed the row this test collides with, rather than inheriting it from the
    // test above — otherwise running this case alone (`jest -t 'ON CONFLICT'`)
    // silently inverts it: the insert succeeds and RETURNING is non-empty.
    const seeded = await insertRow(showA, 'breakpoint', CONFLICT_HOUR);
    expect(seeded).toHaveLength(1);

    const rows = await insertRow(showA, 'breakpoint', CONFLICT_HOUR, sql.unsafe('ON CONFLICT DO NOTHING'));
    expect(rows).toHaveLength(0);

    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM ${sql(SCHEMA)}.flowsheet
      WHERE show_id = ${showA} AND entry_type = 'breakpoint' AND radio_hour = ${CONFLICT_HOUR}::timestamptz`;
    expect(count).toBe(1);
  });

  test('permits the same hour on a different show', async () => {
    // Guards against an index keyed on radio_hour alone: hours are global, so
    // every show in the building shares them.
    await expect(insertRow(showB, 'breakpoint', HOUR)).resolves.toHaveLength(1);
  });

  test('permits non-breakpoint rows to repeat within one hour', async () => {
    // The `entry_type = 'breakpoint'` leg. Tracks legitimately repeat inside
    // an hour — an index without this leg would reject a DJ's second song.
    await expect(insertRow(showA, 'track', HOUR)).resolves.toHaveLength(1);
    await expect(insertRow(showA, 'track', HOUR)).resolves.toHaveLength(1);
  });

  test('permits many breakpoints with a NULL radio_hour', async () => {
    // The `radio_hour IS NOT NULL` leg. ~170k legacy breakpoints carry no
    // hour; they must stay outside the constraint entirely.
    await expect(insertRow(showA, 'breakpoint', null)).resolves.toHaveLength(1);
    await expect(insertRow(showA, 'breakpoint', null)).resolves.toHaveLength(1);
  });

  test('still admits a genuinely different hour on the same show', async () => {
    await expect(insertRow(showA, 'breakpoint', OTHER_HOUR)).resolves.toHaveLength(1);
  });
});
