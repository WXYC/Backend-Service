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
