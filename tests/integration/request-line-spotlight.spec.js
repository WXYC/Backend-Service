/**
 * BS#3472 — while a band or a reader is the current spotlight, a requests-mode `on_air.request_line` reads
 * `closed`/`spotlight`; a host spotlight hands it back. Migration 0205 seeds Backyard BBQ with
 * `default_request_mode = 'feedback'`, which this rule never closes, so the test overrides that seed for its own
 * duration and restores it afterwards.
 *
 * Needs `FLOWSHEET_SPOTLIGHT_ENABLED=true` on the backend service env (set in test.yml and dev_env/docker-compose.yml).
 */
const { getTestDb } = require('../utils/db');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SHOW_NAME = 'bs3472:request-line';

describe('request line follows the spotlight (BS#3472)', () => {
  let sql;
  let seededMode;
  let programId;

  const endShow = () =>
    request.post('/flowsheet/end').set('Authorization', global.access_token).send({ dj_id: global.primary_dj_id });
  const joinShow = async () => {
    await endShow();
    await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({ dj_id: global.primary_dj_id, show_name: SHOW_NAME, specialty_id: programId })
      .expect(200);
  };
  const spotlight = (role, name) =>
    request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({ entry_type: 'spotlight', spotlight_role: role, spotlight_name: name })
      .expect(201);
  const requestLine = async () => (await request.get('/flowsheet').query({ limit: 5 })).body.on_air.request_line;

  beforeAll(async () => {
    sql = getTestDb();
    [{ id: programId, mode: seededMode }] = await sql`
      SELECT id, default_request_mode::text AS mode FROM ${sql(SCHEMA)}.specialty_shows WHERE slug = 'backyard-bbq'`;
    await sql`UPDATE ${sql(SCHEMA)}.specialty_shows SET default_request_mode = 'requests' WHERE id = ${programId}`;
  });

  afterEach(async () => {
    await endShow();
    await sql.unsafe(
      `DELETE FROM ${SCHEMA}.flowsheet WHERE show_id IN (SELECT id FROM ${SCHEMA}.shows WHERE show_name = $1)`,
      [SHOW_NAME]
    );
    await sql.unsafe(
      `DELETE FROM ${SCHEMA}.show_djs WHERE show_id IN (SELECT id FROM ${SCHEMA}.shows WHERE show_name = $1)`,
      [SHOW_NAME]
    );
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE show_name = $1`, [SHOW_NAME]);
  });

  afterAll(async () => {
    await sql`UPDATE ${sql(SCHEMA)}.specialty_shows SET default_request_mode = ${seededMode} WHERE id = ${programId}`;
  });

  it('closes on a performer, and a later host spotlight returns it to requests', async () => {
    await joinShow();
    expect(await requestLine()).toEqual({ mode: 'requests', source: 'program' });

    await spotlight('performer', 'Weirs');
    expect(await requestLine()).toEqual({ mode: 'closed', source: 'spotlight' });

    await spotlight('host', 'Cat Power');
    expect(await requestLine()).toEqual({ mode: 'requests', source: 'program' });
  });

  it("ignores a previous show's spotlight", async () => {
    await joinShow();
    await spotlight('reader', 'Stereolab');
    expect(await requestLine()).toEqual({ mode: 'closed', source: 'spotlight' });

    await joinShow();

    expect(await requestLine()).toEqual({ mode: 'requests', source: 'program' });
  });
});
