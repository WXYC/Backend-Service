const fs = require('fs');
const path = require('path');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '..',
  'shared',
  'database',
  'src',
  'migrations',
  '0190_rotation-thresholds.sql'
);
const DEFAULTS = { window_days: { H: 60, M: 60, L: 60, S: 60 }, card_stale_days: 30 };

/**
 * GET / PATCH /library/rotation/thresholds, and the migration's seed. The table holds one station-wide row that
 * every suite shares, so each test restores the defaults afterwards.
 */
describe('Rotation thresholds', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  afterEach(async () => {
    const sql = getTestDb();
    await sql`
      UPDATE ${sql(SCHEMA)}.rotation_thresholds
      SET window_days_h = 60, window_days_m = 60, window_days_l = 60, window_days_s = 60, card_stale_days = 30`;
  });

  test('GET returns the seeded defaults in the contract shape', async () => {
    const res = await auth.get('/library/rotation/thresholds').expect(200);
    expect(res.body).toEqual(DEFAULTS);
  });

  test('PATCH changes only the supplied values and answers the whole record', async () => {
    const res = await auth
      .patch('/library/rotation/thresholds')
      .send({ window_days: { H: 30 }, card_stale_days: 14 })
      .expect(200);
    const expected = { window_days: { ...DEFAULTS.window_days, H: 30 }, card_stale_days: 14 };
    expect(res.body).toEqual(expected);

    const reread = await auth.get('/library/rotation/thresholds').expect(200);
    expect(reread.body).toEqual(expected);
  });

  test.each([[{}], [{ window_days: {} }]])('PATCH %j is a 200 no-op answering the current record', async (body) => {
    const res = await auth.patch('/library/rotation/thresholds').send(body).expect(200);
    expect(res.body).toEqual(DEFAULTS);
  });

  test.each([
    [{ window_days: { H: 0 } }, 'window_days.H'],
    [{ window_days: { M: 366 } }, 'window_days.M'],
    [{ window_days: { L: 1.5 } }, 'window_days.L'],
    [{ window_days: { S: null } }, 'window_days.S'],
    [{ window_days: { h: 30 } }, 'window_days.h'],
    [{ window_days: null }, 'window_days'],
    [{ card_stale_days: null }, 'card_stale_days'],
    [{ foo: 1 }, 'foo'],
  ])('PATCH %j is a 400 naming %s and leaves the row alone', async (body, named) => {
    const res = await auth.patch('/library/rotation/thresholds').send(body).expect(400);
    expectErrorContains(res, named);

    const reread = await auth.get('/library/rotation/thresholds').expect(200);
    expect(reread.body).toEqual(DEFAULTS);
  });

  test('re-running the migration seed leaves an edited row alone', async () => {
    const sql = getTestDb();
    await auth
      .patch('/library/rotation/thresholds')
      .send({ window_days: { H: 21 }, card_stale_days: 7 })
      .expect(200);

    const seed = fs
      .readFileSync(MIGRATION_PATH, 'utf8')
      .split('\n')
      .map((line) => (line.includes('--') ? line.slice(0, line.indexOf('--')) : line))
      .join('\n')
      .match(/INSERT[\s\S]*?;/gi);
    expect(seed).toHaveLength(1);
    await sql.unsafe(seed[0].replace(/"wxyc_schema"\./g, `"${SCHEMA}".`));

    const res = await auth.get('/library/rotation/thresholds').expect(200);
    expect(res.body).toEqual({ window_days: { ...DEFAULTS.window_days, H: 21 }, card_stale_days: 7 });
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM ${sql(SCHEMA)}.rotation_thresholds`;
    expect(count).toBe(1);
  });
});
