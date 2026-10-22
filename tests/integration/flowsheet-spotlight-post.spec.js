/**
 * BS#3460 — `POST /flowsheet` with `entry_type: spotlight` on a freeform and on a tagged show, and
 * `on_air.spotlight` on the default `GET /flowsheet`, against a real database.
 *
 * Needs `FLOWSHEET_SPOTLIGHT_ENABLED=true` on the backend service env (set in test.yml and dev_env/docker-compose.yml).
 * The flag-off answers (403, no `on_air.spotlight` key) cannot be toggled in a running container; the unit tests cover them.
 */
const { getTestDb } = require('../utils/db');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SHOW_NAME = 'bs3460:spotlight';

describe('POST /flowsheet spotlight entries (BS#3460)', () => {
  let sql;
  let showId;

  const endShow = () =>
    request.post('/flowsheet/end').set('Authorization', global.access_token).send({ dj_id: global.primary_dj_id });
  const joinShow = async (extra = {}) => {
    await endShow();
    const res = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({ dj_id: global.primary_dj_id, show_name: SHOW_NAME, ...extra })
      .expect(200);
    showId = res.body.id;
  };
  const post = (body) => request.post('/flowsheet').set('Authorization', global.access_token).send(body);
  const spotlight = (role, name, extra = {}) =>
    post({ entry_type: 'spotlight', spotlight_role: role, spotlight_name: name, ...extra });
  const feed = (ifModifiedSince) => {
    const req = request.get('/flowsheet').query({ limit: 10 });
    return ifModifiedSince ? req.set('If-Modified-Since', ifModifiedSince) : req;
  };

  beforeAll(() => {
    sql = getTestDb();
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

  it.each([
    ['a freeform show', async () => ({})],
    [
      'a tagged show',
      async () => {
        const [{ id }] = await sql`SELECT id FROM ${sql(SCHEMA)}.specialty_shows WHERE active LIMIT 1`;
        return { specialty_id: id };
      },
    ],
  ])('stores a spotlight on %s, composes its message, and returns it on the feed', async (_label, joinExtra) => {
    await joinShow(await joinExtra());

    const created = await spotlight('guest', '  Weirs  ', { message: 'Talkset' }).expect(201);

    expect(created.body).toMatchObject({
      entry_type: 'spotlight',
      spotlight_role: 'guest',
      spotlight_name: 'Weirs',
      message: 'In the studio: Weirs',
      show_id: showId,
    });
    const [row] = await sql`
      SELECT entry_type::text, spotlight_role::text, spotlight_name, message, artist_name
      FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${created.body.id}`;
    expect(row).toEqual({
      entry_type: 'spotlight',
      spotlight_role: 'guest',
      spotlight_name: 'Weirs',
      message: 'In the studio: Weirs',
      artist_name: '',
    });
    const entry = (await feed()).body.entries.find((e) => e.id === created.body.id);
    expect(entry).toEqual({
      id: created.body.id,
      show_id: showId,
      play_order: created.body.play_order,
      add_time: expect.any(String),
      entry_type: 'spotlight',
      spotlight_role: 'guest',
      spotlight_name: 'Weirs',
      message: 'In the studio: Weirs',
    });
  });

  it('on_air.spotlight is null until the first spotlight, then the newest one; a host row hands the focus back', async () => {
    await joinShow();
    expect((await feed()).body.on_air.spotlight).toBeNull();

    await spotlight('performer', 'Weirs').expect(201);
    const second = await spotlight('reader', 'Stereolab').expect(201);
    expect((await feed()).body.on_air.spotlight).toMatchObject({ id: second.body.id, spotlight_name: 'Stereolab' });

    const host = await spotlight('host', 'Cat Power').expect(201);
    expect((await feed()).body.on_air.spotlight).toMatchObject({ id: host.body.id, spotlight_role: 'host' });
  });

  it("on_air.spotlight ignores a previous show's spotlight", async () => {
    await joinShow();
    await spotlight('performer', 'Weirs').expect(201);

    await joinShow();

    expect((await feed()).body.on_air.spotlight).toBeNull();
  });

  it('inserting a spotlight moves the GET /flowsheet watermark', async () => {
    await joinShow();
    const validator = (await feed()).headers['last-modified'];
    expect((await feed(validator)).status).toBe(304);

    await spotlight('guest', 'Weirs').expect(201);

    let after;
    for (let i = 0; i < 20 && after?.status !== 200; i++) {
      // eslint-disable-next-line no-await-in-loop
      after = await feed(validator);
      if (after.status !== 200) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(after.status).toBe(200);
  });

  it.each([
    ['an unknown role', { spotlight_role: 'emcee' }],
    ['an empty name', { spotlight_name: '' }],
    ['a 129-character name', { spotlight_name: 'a'.repeat(129) }],
    ['artist_name', { artist_name: 'Juana Molina' }],
    ['album_title', { album_title: 'DOGA' }],
    ['track_title', { track_title: 'la paradoja' }],
    ['album_id', { album_id: 1 }],
    ['rotation_id', { rotation_id: 1 }],
    ['record_label', { record_label: 'Sonamos' }],
    ['label_id', { label_id: 1 }],
    ['track_position', { track_position: 'A1' }],
    ['request_flag', { request_flag: false }],
    ['segue', { segue: false }],
  ])('answers 400 for %s and stores nothing', async (_label, over) => {
    await joinShow();

    await spotlight('guest', 'Weirs', over).expect(400);

    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM ${sql(SCHEMA)}.flowsheet
      WHERE show_id = ${showId} AND entry_type = 'spotlight'`;
    expect(count).toBe(0);
  });
});
