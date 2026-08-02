/**
 * Integration test: stub-show start_time repair (BS#1084).
 *
 * When a tubafrenzy webhook arrives referencing a `legacy_show_id` Backend
 * doesn't yet know, `resolveShow` (apps/backend/routes/internal.route.ts)
 * inserts a stub `shows` row with `start_time: new Date()` — a BS-invented
 * placeholder with no authority ("the ETL will fill in details later"). The
 * flowsheet-etl incremental sync's `runIncremental` (jobs/flowsheet-etl/job.ts)
 * re-syncs the same `legacy_show_id` from tubafrenzy on its next tick and must
 * now overwrite the stub's start_time with the authoritative value, instead of
 * leaving the wrong-but-NOW() timestamp to persist indefinitely.
 *
 * The integration runner is babel-jest and cannot import the ETL's
 * drizzle-orm TS source (see flowsheet-etl-setwhere.spec.js's header for the
 * same constraint), so the "next ETL tick" half of this test hand-mirrors
 * `runIncremental`'s shows `onConflictDoUpdate` SQL shape verbatim. If that
 * shape drifts from jobs/flowsheet-etl/job.ts, the unit-test pin at
 * tests/unit/jobs/flowsheet-etl/job.test.ts is the source of truth — fix it
 * there and update here in lockstep.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const INTERNAL_KEY = process.env.ETL_NOTIFY_KEY || 'test-secret-key';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 4,
  });
}

/**
 * Mirrors `runIncremental`'s shows `onConflictDoUpdate` at
 * jobs/flowsheet-etl/job.ts (BS#1084 / BS#1059) — including `start_time` in
 * both the SET list and the value-aware `setWhere` churn-guard.
 */
async function upsertEtlShowShape(sql, row) {
  return sql`
    INSERT INTO ${sql(SCHEMA)}.shows
      (legacy_show_id, legacy_dj_name, legacy_dj_id, start_time, end_time, show_name)
    VALUES
      (${row.legacy_show_id}, ${row.legacy_dj_name}, ${row.legacy_dj_id}, ${row.start_time}, ${row.end_time}, ${row.show_name})
    ON CONFLICT (legacy_show_id) DO UPDATE SET
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      show_name = excluded.show_name,
      legacy_dj_name = excluded.legacy_dj_name,
      legacy_dj_id = excluded.legacy_dj_id
    WHERE
      ${sql(SCHEMA)}.shows.start_time IS DISTINCT FROM excluded.start_time OR
      ${sql(SCHEMA)}.shows.end_time IS DISTINCT FROM excluded.end_time OR
      ${sql(SCHEMA)}.shows.show_name IS DISTINCT FROM excluded.show_name OR
      ${sql(SCHEMA)}.shows.legacy_dj_name IS DISTINCT FROM excluded.legacy_dj_name OR
      ${sql(SCHEMA)}.shows.legacy_dj_id IS DISTINCT FROM excluded.legacy_dj_id
  `;
}

describe('flowsheet-etl start_time repair for webhook stub shows (BS#1084)', () => {
  let sql;
  const LEGACY_SHOW_ID = 9_999_970;
  const LEGACY_ENTRY_ID = 8_888_870;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [LEGACY_ENTRY_ID]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [LEGACY_SHOW_ID]);
  });

  test('a webhook-created stub start_time is overwritten by the next ETL tick', async () => {
    const beforeRequestMs = Date.now();

    // 1) Tubafrenzy webhook delivery for a legacy_show_id Backend doesn't yet
    // know: resolveShow stub-inserts `shows` with start_time = NOW().
    const entry = {
      id: LEGACY_ENTRY_ID,
      radioShowId: LEGACY_SHOW_ID,
      flowsheetEntryType: 6, // track
      artistName: 'Jessica Pratt',
      songTitle: 'Back, Baby',
      releaseTitle: 'On Your Own Love Again',
      labelName: 'Drag City',
      startTime: 1706799600000,
      requestFlag: false,
      sequenceWithinShow: 1,
      libraryReleaseId: 0,
      rotationReleaseId: 0,
    };
    const webhookRes = await request
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'create', entry });
    expect(webhookRes.status).toBe(200);

    const [stub] = await sql.unsafe(`SELECT start_time FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [
      LEGACY_SHOW_ID,
    ]);
    expect(stub).toBeDefined();
    const stubStartTimeMs = new Date(stub.start_time).getTime();
    // The stub's start_time is "now" at insert time. Assert it's recent —
    // NOT the much-earlier authoritative value the ETL is about to sync in —
    // so the later assertion is a genuine before/after, not a coincidence.
    expect(stubStartTimeMs).toBeGreaterThanOrEqual(beforeRequestMs - 5000);

    // 2) The flowsheet-etl incremental tick re-syncs the show from
    // tubafrenzy's authoritative FLOWSHEET_RADIO_SHOW_PROD row, which carries
    // the real start_time — long before the stub's NOW().
    const authoritativeStartTime = new Date('2024-02-01T13:00:00Z');
    await upsertEtlShowShape(sql, {
      legacy_show_id: LEGACY_SHOW_ID,
      legacy_dj_name: 'DJ Bluejay',
      legacy_dj_id: 42,
      start_time: authoritativeStartTime,
      end_time: new Date('2024-02-01T14:00:00Z'),
      show_name: 'The Nest',
    });

    const [healed] = await sql.unsafe(`SELECT start_time, show_name FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [
      LEGACY_SHOW_ID,
    ]);
    expect(new Date(healed.start_time).getTime()).toBe(authoritativeStartTime.getTime());
    expect(healed.show_name).toBe('The Nest');
  });

  test('re-running the same ETL upsert is a no-op once start_time already matches (xmin unchanged)', async () => {
    const row = {
      legacy_show_id: LEGACY_SHOW_ID,
      legacy_dj_name: 'DJ Bluejay',
      legacy_dj_id: 42,
      start_time: new Date('2024-02-01T13:00:00Z'),
      end_time: new Date('2024-02-01T14:00:00Z'),
      show_name: 'The Nest',
    };
    await upsertEtlShowShape(sql, row);
    const [before] = await sql.unsafe(`SELECT xmin::text AS xmin FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [
      LEGACY_SHOW_ID,
    ]);

    await upsertEtlShowShape(sql, row);
    const [after] = await sql.unsafe(`SELECT xmin::text AS xmin FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [
      LEGACY_SHOW_ID,
    ]);
    expect(after.xmin).toBe(before.xmin);
  });
});
