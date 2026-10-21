/**
 * BS#3453 — public `GET /specialty-shows` against the seeded catalog (migration 0201).
 */
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { getTestDb } = require('../utils/db');

const FIELDS = [
  'id',
  'slug',
  'name',
  'short_name',
  'tagline',
  'logs_playcuts',
  'default_spotlight_role',
  'default_request_mode',
  'artwork',
  'accent_color',
  'description',
  'slots',
  'active',
];

describe('GET /specialty-shows (BS#3453)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
  });

  it('serves the nine seeded programs in id order with the SpecialtyShow field names, unauthenticated', async () => {
    const res = await request.get('/specialty-shows').expect(200);

    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toHaveLength(9);
    expect(res.body.map((s) => s.id)).toEqual([...res.body.map((s) => s.id)].sort((a, b) => a - b));
    expect(res.body[0].slug).toBe('orange-county-special');
    expect(res.body[0].name).toBe('Orange County Special');
    for (const show of res.body) {
      expect(Object.keys(show).sort()).toEqual([...FIELDS].sort());
      expect(show.active).toBe(true);
    }
  });

  it('answers 304 to a matching If-None-Match and a new ETag after an UPDATE', async () => {
    const first = await request.get('/specialty-shows').expect(200);
    const etag = first.headers.etag;
    expect(etag).toMatch(/^"\d+"$/);

    await request.get('/specialty-shows').set('If-None-Match', etag).expect(304);

    await sql`UPDATE wxyc_schema.specialty_shows SET tagline = tagline WHERE slug = 'hyperlocal'`;
    const second = await request.get('/specialty-shows').set('If-None-Match', etag).expect(200);
    expect(second.headers.etag).not.toBe(etag);
  });

  it('omits a retired program and moves the ETag when it is retired', async () => {
    const before = await request.get('/specialty-shows').expect(200);
    const target = before.body.find((s) => s.slug === 'hyperlocal');
    expect(target).toBeDefined();

    try {
      await sql`UPDATE wxyc_schema.specialty_shows SET active = false WHERE slug = 'hyperlocal'`;
      const after = await request.get('/specialty-shows').set('If-None-Match', before.headers.etag).expect(200);

      expect(after.body).toHaveLength(before.body.length - 1);
      expect(after.body.map((s) => s.slug)).not.toContain('hyperlocal');
      expect(after.body.every((s) => s.active === true)).toBe(true);
      expect(after.headers.etag).not.toBe(before.headers.etag);
    } finally {
      await sql`UPDATE wxyc_schema.specialty_shows SET active = true WHERE slug = 'hyperlocal'`;
    }
  });
});
