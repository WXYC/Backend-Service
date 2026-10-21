/**
 * BS#3456 — `PATCH /flowsheet/shows/{id}` and migration 0204's `touch_flowsheet_watermark_from_shows` trigger,
 * against a real database. A retag writes no flowsheet row, so the trigger is the only thing that moves the watermark
 * `GET /flowsheet` revalidates against.
 */

const fs = require('fs');
const path = require('path');
const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '..',
  'shared',
  'database',
  'src',
  'migrations',
  '0204_shows-flowsheet-watermark.sql'
);

describe('show edits and the flowsheet watermark (BS#3456)', () => {
  let sql;
  let specialtyId;
  let showId;

  const endShow = () =>
    request.post('/flowsheet/end').set('Authorization', global.access_token).send({ dj_id: global.primary_dj_id });
  const feed = (ifModifiedSince) => {
    const req = request.get('/flowsheet').query({ limit: 5 });
    return ifModifiedSince ? req.set('If-Modified-Since', ifModifiedSince) : req;
  };
  const triggerCount = async () => {
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname = 'touch_flowsheet_watermark_from_shows' AND NOT tgisinternal`;
    return count;
  };

  beforeAll(async () => {
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
      max: 2,
    });
    [{ id: specialtyId }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.specialty_shows (specialty_name, slug, short_name)
      VALUES ('BS3456 Probe', 'bs3456-probe', 'Probe') RETURNING id`;
    await endShow();
    const join = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({ dj_id: global.primary_dj_id });
    showId = join.body.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await endShow();
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE show_id = $1`, [showId]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.show_djs WHERE show_id = $1`, [showId]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE id = $1`, [showId]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.specialty_shows WHERE id = $1`, [specialtyId]);
    await sql.end();
  });

  it('a PATCH moves the watermark: a conditional GET with the old validator gets 200, not 304', async () => {
    const baseline = await feed();
    expect(baseline.status).toBe(200);
    const validator = baseline.headers['last-modified'];
    expect((await feed(validator)).status).toBe(304);

    const patched = await request
      .patch(`/flowsheet/shows/${showId}`)
      .set('Authorization', global.access_token)
      .send({ specialty_id: specialtyId, show_name: '  Probe Hour  ' })
      .expect(200);
    expect(patched.body).toMatchObject({
      id: showId,
      show_name: 'Probe Hour',
      specialty_id: specialtyId,
      specialty: { id: specialtyId, slug: 'bs3456-probe' },
    });

    // The trigger's `+1s` floor guarantees a whole-second advance; poll so an unflushed read cannot race the assertion.
    let status = 304;
    for (let i = 0; i < 20 && status !== 200; i++) {
      // eslint-disable-next-line no-await-in-loop
      status = (await feed(validator)).status;
      // eslint-disable-next-line no-await-in-loop
      if (status !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe(200);
  });

  it('a PATCH writes no flowsheet row', async () => {
    const [{ before }] =
      await sql`SELECT count(*)::int AS before FROM ${sql(SCHEMA)}.flowsheet WHERE show_id = ${showId}`;
    await request
      .patch(`/flowsheet/shows/${showId}`)
      .set('Authorization', global.access_token)
      .send({ specialty_id: null })
      .expect(200);
    const [{ after }] =
      await sql`SELECT count(*)::int AS after FROM ${sql(SCHEMA)}.flowsheet WHERE show_id = ${showId}`;

    expect(after).toBe(before);
  });

  it('exists after migrating, and re-running the migration trigger statements is harmless', async () => {
    expect(await triggerCount()).toBe(1);

    const statements = fs
      .readFileSync(MIGRATION_PATH, 'utf8')
      .replace(/wxyc_schema/g, SCHEMA)
      .split('--> statement-breakpoint');
    for (const statement of statements) {
      await sql.unsafe(statement);
    }

    expect(await triggerCount()).toBe(1);
  });
});
