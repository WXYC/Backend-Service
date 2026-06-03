/**
 * Integration tests for POST /internal/rotation-webhook (BS#1082).
 *
 * The webhook receives tubafrenzy rotation events. The acceptance criterion
 * tested here is from #1082: when `sendRotationLinked` posts the partial
 * shape `{id, libraryReleaseId, action: 'update'}`, the receiver must NOT
 * clobber `rotation_bin` or `kill_date` with the JS-default values computed
 * for missing payload fields.
 *
 * The companion unit test at `tests/unit/routes/internal.route.test.ts`
 * verifies the SET-clause shape against a mocked db; this spec verifies the
 * end-to-end behavior at the row level against real Postgres.
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

describe('POST /internal/rotation-webhook — partial update preserves rotation_bin / kill_date (BS#1082)', () => {
  let sql;

  // Use a legacy_rotation_id deep in a range that's unlikely to collide.
  const LEGACY_ROTATION_ID = 9_999_982;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`, [LEGACY_ROTATION_ID]);
  });

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`, [LEGACY_ROTATION_ID]);
  });

  async function seedHeavyRotationRow(killDate) {
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.rotation
         (legacy_rotation_id, rotation_bin, add_date, kill_date, artist_name, album_title, record_label)
       VALUES ($1, 'H', '2026-01-01', $2, 'Jessica Pratt', 'On Your Own Love Again', 'Drag City')`,
      [LEGACY_ROTATION_ID, killDate]
    );
  }

  test('linkage update {id, libraryReleaseId} preserves existing rotation_bin and kill_date', async () => {
    await seedHeavyRotationRow('2026-12-31');

    const res = await request
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'update', release: { id: LEGACY_ROTATION_ID, libraryReleaseId: 0 } });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT rotation_bin, kill_date FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    expect(row.rotation_bin).toBe('H');
    expect(row.kill_date).toEqual(new Date('2026-12-31'));
  });

  test('full-shape update {rotationType, killDate} still overwrites those fields', async () => {
    await seedHeavyRotationRow('2026-12-31');

    const res = await request
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({
        action: 'update',
        release: {
          id: LEGACY_ROTATION_ID,
          libraryReleaseId: 0,
          rotationType: 'M',
          killDate: 0,
          artistName: 'Jessica Pratt',
          albumTitle: 'On Your Own Love Again',
          labelName: 'Drag City',
          addDate: 1706799600000,
        },
      });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT rotation_bin, kill_date FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    expect(row.rotation_bin).toBe('M');
    expect(row.kill_date).toBeNull();
  });
});
