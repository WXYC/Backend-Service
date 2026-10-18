const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');
const fls_util = require('../utils/flowsheet_util');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const NAME_PREFIX = 'bs3438:';
const ORIGINAL_TITLE = 'Cherokee';

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

/**
 * Integration tests for BS#3438: `PATCH /flowsheet`, `DELETE /flowsheet` and `PATCH /flowsheet/play-order` authorize
 * the caller against the show the TARGET ROW belongs to, not against whichever show is open. Before the fix the DJ on
 * the air could edit, delete or reorder any row in the table by id.
 *
 * The rows on other shows are inserted directly: there is no API path that writes to a closed show, which is the
 * point. Their shows start in 2000 so the live show the fixtures open stays the latest one.
 */
describe('flowsheet row writes are scoped to the row’s own open show (BS#3438)', () => {
  let sql;
  let liveShowId;

  const routes = [
    [
      'PATCH /flowsheet',
      (id, auth) =>
        request
          .patch('/flowsheet')
          .set('Authorization', auth)
          .send({ entry_id: id, data: { track_title: 'edited' } }),
    ],
    ['DELETE /flowsheet', (id, auth) => request.delete('/flowsheet').set('Authorization', auth).send({ entry_id: id })],
    [
      'PATCH /flowsheet/play-order',
      (id, auth) =>
        request.patch('/flowsheet/play-order').set('Authorization', auth).send({ entry_id: id, new_position: 1 }),
    ],
  ];

  const insertRow = async (showId, playOrder) => {
    const [row] = await sql.unsafe(
      `INSERT INTO ${SCHEMA}.flowsheet (show_id, entry_type, artist_name, track_title, play_order)
       VALUES ($1, 'track', 'Cat Power', $2, $3) RETURNING id`,
      [showId, ORIGINAL_TITLE, playOrder]
    );
    return row.id;
  };

  const insertShow = async (suffix, endTime) => {
    const [row] = await sql.unsafe(
      `INSERT INTO ${SCHEMA}.shows (show_name, start_time, end_time)
       VALUES ($1, '2000-01-01 00:00:00+00', $2) RETURNING id`,
      [NAME_PREFIX + suffix, endTime]
    );
    return row.id;
  };

  const snapshot = async (id) =>
    (await sql.unsafe(`SELECT track_title, play_order FROM ${SCHEMA}.flowsheet WHERE id = $1`, [id]))[0];

  beforeAll(async () => {
    sql = makeSql();
  });

  beforeEach(async () => {
    const res = await fls_util.join_show(global.primary_dj_id, global.access_token, {
      show_name: `${NAME_PREFIX}live`,
    });
    liveShowId = (await res.json()).id;
    await fls_util.join_show(global.secondary_dj_id, global.secondary_access_token, { intent: 'join' });
  });

  afterEach(async () => {
    await fls_util.leave_show(global.secondary_dj_id, global.secondary_access_token);
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE track_title = $1 AND artist_name = 'Cat Power'`, [
      ORIGINAL_TITLE,
    ]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE show_name LIKE $1`, [`${NAME_PREFIX}%`]);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  describe.each(routes)('%s', (_name, send) => {
    test.each([
      ['an ended show', async () => insertRow(await insertShow('ended', '2000-01-01 02:00:00+00'), 2)],
      ['an open show the caller is not a member of', async () => insertRow(await insertShow('foreign-open', null), 2)],
      ['no show at all (NULL show_id)', async () => insertRow(null, 2)],
    ])('rejects a row on %s with a 400 and leaves it unchanged', async (_case, seed) => {
      const id = await seed();
      const before = await snapshot(id);

      await send(id, global.access_token).expect(400);

      expect(await snapshot(id)).toEqual(before);
    });

    test.each([
      ['the primary DJ', () => global.access_token],
      ['a co-host', () => global.secondary_access_token],
    ])('accepts a row of the open show from %s', async (_who, auth) => {
      const id = await insertRow(liveShowId, 2);

      await send(id, auth()).expect(200);
    });
  });
});
