/**
 * BS#3471 — migration 0205 (`request_line_mode`, `shows.request_mode`, `specialty_shows.default_request_mode` and the
 * four-program seed), `PATCH /flowsheet/shows/{id}` with `request_mode`, and `on_air.request_line`, against a real
 * database. db-init already applied the migration to an empty database inside the single migrate transaction.
 */

const { getTestDb } = require('../utils/db');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const FEEDBACK_SLUGS = ['backyard-bbq', 'friday-night-story-hour', 'hyperlocal', 'inside-track'];

describe('request-line modes (BS#3471)', () => {
  let sql;
  let showId;

  const endShow = () =>
    request.post('/flowsheet/end').set('Authorization', global.access_token).send({ dj_id: global.primary_dj_id });
  const feed = (ifModifiedSince) => {
    const req = request.get('/flowsheet').query({ limit: 5 });
    return ifModifiedSince ? req.set('If-Modified-Since', ifModifiedSince) : req;
  };
  const patchMode = (request_mode) =>
    request.patch(`/flowsheet/shows/${showId}`).set('Authorization', global.access_token).send({ request_mode });

  beforeAll(async () => {
    sql = getTestDb();
    await endShow();
    const join = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({ dj_id: global.primary_dj_id });
    showId = join.body.id;
  });

  afterAll(async () => {
    await endShow();
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE show_id = $1`, [showId]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.show_djs WHERE show_id = $1`, [showId]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE id = $1`, [showId]);
  });

  it('seeds feedback on the four programs whose formats cannot take song requests, and nothing on the other five', async () => {
    const rows = await sql`
      SELECT slug, default_request_mode::text AS mode FROM ${sql(SCHEMA)}.specialty_shows ORDER BY slug`;

    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.mode === 'feedback').map((r) => r.slug)).toEqual(FEEDBACK_SLUGS);
    expect(rows.filter((r) => r.mode !== 'feedback' && r.mode !== null)).toEqual([]);
  });

  it('publishes default_request_mode on GET /specialty-shows', async () => {
    const res = await request.get('/specialty-shows').expect(200);

    const byMode = Object.fromEntries(res.body.map((s) => [s.slug, s.default_request_mode]));
    expect(byMode.hyperlocal).toBe('feedback');
    expect(byMode['orange-county-special']).toBeNull();
  });

  it('rejects a request_mode outside the enum with 400', async () => {
    await patchMode('loud').expect(400);
  });

  it('a PATCH of request_mode is stored, reaches on_air.request_line, and moves the flowsheet watermark', async () => {
    const baseline = await feed();
    const validator = baseline.headers['last-modified'];
    expect(baseline.body.on_air.request_line).toEqual({ mode: 'requests', source: 'default' });
    expect((await feed(validator)).status).toBe(304);

    await patchMode('feedback').expect(200);
    const [{ request_mode }] = await sql`SELECT request_mode::text FROM ${sql(SCHEMA)}.shows WHERE id = ${showId}`;
    expect(request_mode).toBe('feedback');

    // The trigger's `+1s` floor guarantees a whole-second advance; poll so an unflushed read cannot race the assertion.
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
    expect(after.body.on_air.request_line).toEqual({ mode: 'feedback', source: 'dj' });
  });

  it('null clears the DJs choice so the show defers again', async () => {
    await patchMode(null).expect(200);

    const [{ request_mode }] = await sql`SELECT request_mode FROM ${sql(SCHEMA)}.shows WHERE id = ${showId}`;
    expect(request_mode).toBeNull();
  });
});
