const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');
const fls_util = require('../utils/flowsheet_util');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const NAME_PREFIX = 'bs3459:';

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
 * Integration test for BS#3459: `PATCH /flowsheet` on a spotlight row fixes a misspelled name in the row, keeps its
 * play order, recomposes `message`, refuses a track field with 400, and cannot retype the row.
 *
 * Needs `FLOWSHEET_SPOTLIGHT_ENABLED=true` on the backend service env (set in test.yml and dev_env/docker-compose.yml).
 * The spotlight row is inserted directly: the POST path that writes one is BS#3460.
 */
describe('PATCH /flowsheet on a spotlight row (BS#3459)', () => {
  let sql;
  let rowId;

  const snapshot = async () =>
    (
      await sql.unsafe(
        `SELECT entry_type, spotlight_role, spotlight_name, message, play_order FROM ${SCHEMA}.flowsheet WHERE id = $1`,
        [rowId]
      )
    )[0];

  const patch = (data) =>
    request.patch('/flowsheet').set('Authorization', global.access_token).send({ entry_id: rowId, data });

  beforeAll(async () => {
    sql = makeSql();
  });

  beforeEach(async () => {
    const res = await fls_util.join_show(global.primary_dj_id, global.access_token, {
      show_name: `${NAME_PREFIX}live`,
    });
    const showId = (await res.json()).id;
    const [row] = await sql.unsafe(
      `INSERT INTO ${SCHEMA}.flowsheet (show_id, entry_type, artist_name, album_title, track_title, message, spotlight_role, spotlight_name, play_order)
       VALUES ($1, 'spotlight', '', '', '', 'In the studio: Weirz', 'guest', 'Weirz', 1000) RETURNING id`,
      [showId]
    );
    rowId = row.id;
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
    await sql.unsafe(
      `DELETE FROM ${SCHEMA}.flowsheet WHERE show_id IN (SELECT id FROM ${SCHEMA}.shows WHERE show_name LIKE $1)`,
      [`${NAME_PREFIX}%`]
    );
    await sql.unsafe(
      `DELETE FROM ${SCHEMA}.show_djs WHERE show_id IN (SELECT id FROM ${SCHEMA}.shows WHERE show_name LIKE $1)`,
      [`${NAME_PREFIX}%`]
    );
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE show_name LIKE $1`, [`${NAME_PREFIX}%`]);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  test.each([
    ['a corrected name', { spotlight_name: '  Weirs ' }, 'guest', 'Weirs', 'In the studio: Weirs'],
    ['a new role', { spotlight_role: 'reader' }, 'reader', 'Weirz', 'Reading now: Weirz'],
    [
      'both, with a client message and entry_type ignored',
      { spotlight_role: 'performer', spotlight_name: 'Weirs', message: 'typed', entry_type: 'track' },
      'performer',
      'Weirs',
      'Live in the studio: Weirs',
    ],
  ])('accepts %s, recomposes message and keeps the play order', async (_label, data, role, name, message) => {
    await patch(data).expect(200);

    expect(await snapshot()).toEqual({
      entry_type: 'spotlight',
      spotlight_role: role,
      spotlight_name: name,
      message,
      play_order: 1000,
    });
  });

  test.each([
    ['an unknown role', { spotlight_role: 'emcee' }],
    ['an empty name', { spotlight_name: '' }],
    ['a 129-character name', { spotlight_name: 'a'.repeat(129) }],
    ['a track field', { track_title: 'Cherokee' }],
  ])('rejects %s with 400 and leaves the row unchanged', async (_label, data) => {
    const before = await snapshot();

    await patch(data).expect(400);

    expect(await snapshot()).toEqual(before);
  });
});
