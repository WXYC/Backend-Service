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
  // rows). This test seeds a stub show with a `legacy_dj_name`, delivers a
  // show_start (flowsheetEntryType=9) for it, and asserts the inserted row
  // picked the legacy_dj_name from the COALESCE.
  test('show_start webhook resolves dj_name from shows.legacy_dj_name (BS#1371)', async () => {
    const LEGACY_SHOW_ID = 9_999_990;
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.shows (legacy_show_id, legacy_dj_name, start_time) VALUES ($1, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [LEGACY_SHOW_ID, "T'mia Powell"]
    );

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
      // Clear the flowsheet row before the show — flowsheet.show_id is an
      // FK to shows.id and not ON DELETE CASCADE, so the show DELETE would
      // otherwise fail. afterEach also clears the flowsheet row by
      // legacy_entry_id (idempotent), but it runs after this finally.
      await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [LEGACY_ENTRY_ID]);
      await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [LEGACY_SHOW_ID]);
    }
  });

  test('track webhook leaves dj_name NULL even when the show has a resolved name (BS#1371)', async () => {
    // Track rows have their own dj_name population path (ETL + live insert).
    // The webhook must NOT write dj_name on track rows so we don't double-
    // write and risk drift between the webhook and the ETL writer.
    const LEGACY_SHOW_ID = 9_999_989;
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.shows (legacy_show_id, legacy_dj_name, start_time) VALUES ($1, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [LEGACY_SHOW_ID, 'Some Resolvable Name']
    );

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
      await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [LEGACY_ENTRY_ID]);
      await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [LEGACY_SHOW_ID]);
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
