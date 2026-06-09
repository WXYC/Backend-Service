/**
 * Integration tests for POST /internal/rotation-webhook (BS#1082, BS#1312).
 *
 * The webhook receives tubafrenzy rotation events. The acceptance criterion
 * tested here is from #1082 + #1312: when `sendRotationLinked` posts the
 * partial shape `{id, libraryReleaseId, action: 'update'}`, the receiver
 * must NOT clobber the existing row's `rotation_bin`, `kill_date`,
 * `artist_name`, `album_title`, or `record_label` with the JS-default
 * values computed for missing payload fields. The denorm trio is the
 * surface tubafrenzy + dj-site catalog views render when `album_id IS NULL`
 * — clobbering them turns Heavy rotation rows display-blind until the 30m
 * rotation-etl cron repairs them.
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

describe('POST /internal/rotation-webhook — partial update preserves denorm fields (BS#1082 + BS#1312)', () => {
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

  test('linkage update {id, libraryReleaseId} preserves all five denorm fields (rotation_bin, kill_date, artist_name, album_title, record_label)', async () => {
    await seedHeavyRotationRow('2026-12-31');

    const res = await request
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'update', release: { id: LEGACY_ROTATION_ID, libraryReleaseId: 0 } });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT rotation_bin, kill_date, artist_name, album_title, record_label
         FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    expect(row.rotation_bin).toBe('H');
    expect(row.kill_date).toEqual(new Date('2026-12-31'));
    expect(row.artist_name).toBe('Jessica Pratt');
    expect(row.album_title).toBe('On Your Own Love Again');
    expect(row.record_label).toBe('Drag City');
  });

  test('full-shape update {rotationType, killDate, artistName, albumTitle, labelName} overwrites all five denorm fields', async () => {
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
          artistName: 'Juana Molina',
          albumTitle: 'DOGA',
          labelName: 'Sonamos',
          addDate: 1706799600000,
        },
      });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT rotation_bin, kill_date, artist_name, album_title, record_label
         FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    expect(row.rotation_bin).toBe('M');
    expect(row.kill_date).toBeNull();
    expect(row.artist_name).toBe('Juana Molina');
    expect(row.album_title).toBe('DOGA');
    expect(row.record_label).toBe('Sonamos');
  });
});
