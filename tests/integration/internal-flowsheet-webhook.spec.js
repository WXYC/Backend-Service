/**
 * Integration tests for POST /internal/flowsheet-webhook (BS#909 / H2).
 *
 * The webhook receives tubafrenzy flowsheet events. The acceptance criterion
 * tested here is (c) from issue #909: under a concurrent INSERT race (two
 * webhook deliveries with the same `legacy_entry_id` arriving in flight), PG's
 * INSERT ... ON CONFLICT DO NOTHING serializes the two writes and exactly one
 * delivery sees a fresh INSERT (and would fire enrichment); the other sees an
 * empty RETURNING and falls through to UPDATE without re-firing.
 *
 * This integration test exercises that against real Postgres. The unit-test
 * companion at `tests/unit/routes/internal.route.test.ts` covers fresh-INSERT
 * and ON-CONFLICT branches individually with mocked DB chains; only the
 * concurrent race needs a real engine because the guarantee is the engine's,
 * not the handler's.
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

describe('POST /internal/flowsheet-webhook — concurrent INSERT race (BS#909)', () => {
  let sql;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  // Use a legacy_entry_id deep in a range that's unlikely to collide with any
  // fixture or other spec's writes. The afterEach cleanup deletes by this id.
  const LEGACY_ENTRY_ID = 9_999_991;

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [LEGACY_ENTRY_ID]);
  });

  const buildEntry = (overrides = {}) => ({
    id: LEGACY_ENTRY_ID,
    radioShowId: 0,
    flowsheetEntryType: 6,
    artistName: 'Chuquimamani-Condori',
    songTitle: 'Call Your Name',
    releaseTitle: 'Edits',
    labelName: 'self-released',
    startTime: 1706799600000,
    requestFlag: false,
    sequenceWithinShow: 1,
    libraryReleaseId: 0,
    rotationReleaseId: 0,
    ...overrides,
  });

  test('two concurrent webhook deliveries produce exactly one row', async () => {
    const entry = buildEntry();
    const responses = await Promise.all([
      request.post('/internal/flowsheet-webhook').set('X-Internal-Key', INTERNAL_KEY).send({ action: 'create', entry }),
      request.post('/internal/flowsheet-webhook').set('X-Internal-Key', INTERNAL_KEY).send({ action: 'create', entry }),
    ]);

    // Both webhook calls succeed (one inserts, one updates); HTTP 200 either way.
    for (const r of responses) expect(r.status).toBe(200);

    // Exactly one row exists for this legacy_entry_id.
    const rows = await sql.unsafe(`SELECT id, artist_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
      LEGACY_ENTRY_ID,
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].artist_name).toBe('Chuquimamani-Condori');
  });

  // BS#1371: marker entry types delivered via the webhook must carry
  // `dj_name` resolved via COALESCE(auth_user.dj_name, shows.legacy_dj_name,
  // auth_user.name). Pre-fix, every webhook-delivered show_start /
  // show_end / dj_join / dj_leave row landed with dj_name=NULL and the v2
  // wire emitted '' (iOS rendered an empty handle for ~119k historical
  // rows). The three cases below cover the three resolution arms.
  //
  // `seedShow` pre-DELETEs (defensive against a prior crashed test leaving
  // a polluted row that would otherwise survive a naive INSERT...ON
  // CONFLICT DO NOTHING and produce a confusing false pass/fail). `clearShow`
  // clears the flowsheet row before the show (FK ordering — shows is not
  // ON DELETE CASCADE).
  const seedShow = async (legacyShowId, { legacyDjName = null, primaryDjId = null } = {}) => {
    await sql.unsafe(
      `DELETE FROM ${SCHEMA}.flowsheet WHERE show_id IN (SELECT id FROM ${SCHEMA}.shows WHERE legacy_show_id = $1)`,
      [legacyShowId]
    );
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [legacyShowId]);
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.shows (legacy_show_id, legacy_dj_name, primary_dj_id, start_time) VALUES ($1, $2, $3, NOW())`,
      [legacyShowId, legacyDjName, primaryDjId]
    );
  };
  const clearShow = async (legacyShowId) => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [LEGACY_ENTRY_ID]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [legacyShowId]);
  };

  test('show_start webhook resolves dj_name from shows.legacy_dj_name (BS#1371)', async () => {
    const LEGACY_SHOW_ID = 9_999_990;
    await seedShow(LEGACY_SHOW_ID, { legacyDjName: "T'mia Powell" });

    try {
      const entry = buildEntry({ flowsheetEntryType: 9, radioShowId: LEGACY_SHOW_ID });
      const res = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({ action: 'create', entry });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(`SELECT entry_type, dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        LEGACY_ENTRY_ID,
      ]);
      expect(rows.length).toBe(1);
      expect(rows[0].entry_type).toBe('show_start');
      expect(rows[0].dj_name).toBe("T'mia Powell");
    } finally {
      await clearShow(LEGACY_SHOW_ID);
    }
  });

  // Highest-priority COALESCE arm. Seeds an auth_user, points shows.primary_dj_id
  // at it, and asserts the resolver picked user.dj_name over legacy_dj_name.
  // Without this case the LEFT JOIN to auth_user is never exercised against real
  // Postgres; a schema rename of auth_user.dj_name would leave the legacy_dj_name
  // case (above) green while production silently regressed on the primary arm.
  test('show_start webhook prefers auth_user.dj_name over legacy_dj_name (BS#1371)', async () => {
    const LEGACY_SHOW_ID = 9_999_988;
    const PRIMARY_DJ_ID = 'test-dj1-id-00000000000000000001'; // seeded in dev_env/seed_db.sql with dj_name='Test dj1'
    await seedShow(LEGACY_SHOW_ID, { legacyDjName: 'Legacy Override Loser', primaryDjId: PRIMARY_DJ_ID });

    try {
      const entry = buildEntry({ flowsheetEntryType: 9, radioShowId: LEGACY_SHOW_ID });
      const res = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({ action: 'create', entry });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(`SELECT entry_type, dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        LEGACY_ENTRY_ID,
      ]);
      expect(rows.length).toBe(1);
      expect(rows[0].entry_type).toBe('show_start');
      expect(rows[0].dj_name).toBe('Test dj1');
    } finally {
      await clearShow(LEGACY_SHOW_ID);
    }
  });

  test('track webhook leaves dj_name NULL even when the show has a resolved name (BS#1371)', async () => {
    // Track rows have their own dj_name population path (ETL + live insert).
    // The webhook must NOT write dj_name on track rows so we don't double-
    // write and risk drift between the webhook and the ETL writer.
    const LEGACY_SHOW_ID = 9_999_989;
    await seedShow(LEGACY_SHOW_ID, { legacyDjName: 'Some Resolvable Name' });

    try {
      const entry = buildEntry({ flowsheetEntryType: 6, radioShowId: LEGACY_SHOW_ID });
      const res = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({ action: 'create', entry });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(`SELECT entry_type, dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        LEGACY_ENTRY_ID,
      ]);
      expect(rows.length).toBe(1);
      expect(rows[0].entry_type).toBe('track');
      expect(rows[0].dj_name).toBeNull();
    } finally {
      await clearShow(LEGACY_SHOW_ID);
    }
  });

  test('a second delivery with different mutable fields refreshes those fields', async () => {
    // First delivery: fresh INSERT — the row carries the initial payload.
    const initial = buildEntry({ artistName: 'Juana Molina', songTitle: 'la paradoja', releaseTitle: 'DOGA' });
    const firstRes = await request
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'create', entry: initial });
    expect(firstRes.status).toBe(200);

    // Second delivery: same legacy_entry_id, refreshed mutable fields. The
    // INSERT branch sees a conflict, so the handler falls through to the
    // explicit UPDATE path. We assert the row's mutable subset moved.
    const refreshed = buildEntry({
      artistName: 'Juana Molina',
      songTitle: 'la paradoja',
      releaseTitle: 'DOGA (remastered)',
    });
    const secondRes = await request
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'update', entry: refreshed });
    expect(secondRes.status).toBe(200);

    const rows = await sql.unsafe(`SELECT album_title FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
      LEGACY_ENTRY_ID,
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].album_title).toBe('DOGA (remastered)');
  });
});
