/**
 * BS#3454 — `specialty` (SpecialtyShowRef) on `GET /flowsheet/range` and
 * `GET /flowsheet/playlist`, against a real database.
 *
 * Writes its own catalog rows (one active, one retired) rather than leaning on
 * the migration-0201 seeds, so the assertions hold on any schema. The window is
 * placed in 1997, outside every other fixture. Torn down in afterAll.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const WINDOW_START = Date.UTC(1997, 3, 2, 4, 0, 0);
const WINDOW_END = WINDOW_START + 24 * 60 * 60 * 1000;
const at = (offsetMs) => new Date(WINDOW_START + offsetMs).toISOString();

describe('specialty ref on range and playlist (BS#3454)', () => {
  let sql;
  const specialtyIds = {};
  const showIds = {};

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

    const insertSpecialty = async (key, slug, active) => {
      const rows = await sql`
        INSERT INTO ${sql(SCHEMA)}.specialty_shows (specialty_name, slug, short_name, active)
        VALUES (${`BS3454 ${slug}`}, ${slug}, ${slug.slice(0, 12)}, ${active})
        RETURNING id`;
      specialtyIds[key] = rows[0].id;
    };
    await insertSpecialty('active', 'bs3454-active', true);
    await insertSpecialty('retired', 'bs3454-retired', false);

    const insertShow = async (key, offset, specialtyId) => {
      const rows = await sql`
        INSERT INTO ${sql(SCHEMA)}.shows (start_time, end_time, specialty_id)
        VALUES (${at(offset)}::timestamptz, ${at(offset + 3600000)}::timestamptz, ${specialtyId})
        RETURNING id`;
      showIds[key] = rows[0].id;
    };
    await insertShow('active', 0, specialtyIds.active);
    await insertShow('retired', 7200000, specialtyIds.retired);
    await insertShow('untagged', 14400000, null);
  });

  afterAll(async () => {
    if (!sql) return;
    // The join tests start real shows tagged with the active program: clear them and their rows first.
    const joined = await sql.unsafe(`SELECT id FROM ${SCHEMA}.shows WHERE specialty_id = ANY($1::int[])`, [
      Object.values(specialtyIds),
    ]);
    const allShowIds = [...new Set([...joined.map((r) => r.id), ...Object.values(showIds)])];
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE show_id = ANY($1::int[])`, [allShowIds]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.show_djs WHERE show_id = ANY($1::int[])`, [allShowIds]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE id = ANY($1::int[])`, [allShowIds]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.specialty_shows WHERE id = ANY($1::int[])`, [Object.values(specialtyIds)]);
    await sql.end();
  });

  const expectedRef = (key, slug) => ({
    id: specialtyIds[key],
    slug,
    name: `BS3454 ${slug}`,
    short_name: slug.slice(0, 12),
  });

  it('GET /flowsheet/range embeds the ref, resolves retired programs, and nulls untagged shows', async () => {
    const res = await request.get(`/flowsheet/range?start=${WINDOW_START}&end=${WINDOW_END}`).expect(200);
    const byId = Object.fromEntries(res.body.shows.map((s) => [s.id, s]));

    expect(byId[showIds.active].specialty).toMatchObject(expectedRef('active', 'bs3454-active'));
    expect(byId[showIds.retired].specialty).toMatchObject(expectedRef('retired', 'bs3454-retired'));
    expect(byId[showIds.untagged].specialty).toBeNull();
  });

  it.each([
    ['active', 'bs3454-active'],
    ['retired', 'bs3454-retired'],
  ])('GET /flowsheet/playlist embeds the %s ref beside specialty_show_name', async (key, slug) => {
    const res = await request.get('/flowsheet/playlist').query({ show_id: showIds[key] }).expect(200);

    expect(res.body.specialty).toMatchObject(expectedRef(key, slug));
    expect(res.body.specialty_show_name).toBe(`BS3454 ${slug}`);
  });

  it('GET /flowsheet/playlist answers specialty: null for an untagged show', async () => {
    const res = await request.get('/flowsheet/playlist').query({ show_id: showIds.untagged }).expect(200);

    expect(res.body.specialty).toBeNull();
  });

  describe('POST /flowsheet/join specialty_id validation', () => {
    const endShow = () =>
      request.post('/flowsheet/end').set('Authorization', global.access_token).send({ dj_id: global.primary_dj_id });
    const join = (specialty_id) =>
      request
        .post('/flowsheet/join')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id, show_name: 'BS3454 join', specialty_id });

    beforeEach(endShow);
    afterAll(endShow);

    it('refuses a retired (active = false) program with 400', async () => {
      await join(specialtyIds.retired).expect(400);
    });

    it.each([['abc'], [7.5], [0], [-1]])(
      'refuses the non-integer or non-positive id %p with 400, not 500',
      async (bad) => {
        await join(bad).expect(400);
      }
    );

    it('accepts an active program', async () => {
      const res = await join(specialtyIds.active).expect(200);

      expect(res.body.specialty_id).toBe(specialtyIds.active);
    });
  });
  describe('on_air and the Go Live 409 name the open show (BS#3457)', () => {
    const endShow = () =>
      request.post('/flowsheet/end').set('Authorization', global.access_token).send({ dj_id: global.primary_dj_id });

    beforeEach(endShow);
    afterAll(endShow);

    it('GET /flowsheet carries show_id, show_name and the specialty slug for a tagged show, and nulls for a freeform one', async () => {
      const joined = await request
        .post('/flowsheet/join')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id, show_name: 'BS3457 tagged', specialty_id: specialtyIds.active })
        .expect(200);

      const tagged = await request.get('/flowsheet').expect(200);
      expect(tagged.body.on_air).toMatchObject({
        show_id: joined.body.id,
        show_name: 'BS3457 tagged',
        specialty: { slug: 'bs3454-active' },
      });

      await endShow();
      const freeform = await request
        .post('/flowsheet/join')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id })
        .expect(200);

      const untagged = await request.get('/flowsheet').expect(200);
      expect(untagged.body.on_air).toMatchObject({ show_id: freeform.body.id, show_name: null, specialty: null });
    });

    it('the 409 for a second DJ names the tagged show and its program', async () => {
      await request
        .post('/flowsheet/join')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id, show_name: 'BS3457 tagged', specialty_id: specialtyIds.active })
        .expect(200);

      const conflict = await request
        .post('/flowsheet/join')
        .set('Authorization', global.secondary_access_token)
        .send({ dj_id: global.secondary_dj_id })
        .expect(409);

      expect(conflict.body.code).toBe('show_already_open');
      expect(conflict.body.details.show).toMatchObject({
        show_name: 'BS3457 tagged',
        specialty: { slug: 'bs3454-active' },
      });
    });
  });

  describe('shows[] on the default GET /flowsheet branch (BS#3461)', () => {
    const FAR_FUTURE = Date.UTC(2226, 0, 1);
    const endShow = () =>
      request.post('/flowsheet/end').set('Authorization', global.access_token).send({ dj_id: global.primary_dj_id });

    beforeEach(endShow);
    afterAll(endShow);

    it('returns the tagged and freeform shows behind the page, plus the open show when none of its rows is on it', async () => {
      // Two far-future rows sort ahead of everything else, so `limit=2` is exactly this pair.
      await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet (show_id, add_time, entry_type, play_order, artist_name, album_title, track_title)
        VALUES
          (${showIds.active}, ${new Date(FAR_FUTURE).toISOString()}::timestamptz, 'track', 1, 'Juana Molina', 'DOGA', 'la paradoja'),
          (${showIds.untagged}, ${new Date(FAR_FUTURE + 1000).toISOString()}::timestamptz, 'track', 1, 'Jessica Pratt', 'On Your Own Love Again', 'Back, Baby')`;
      const joined = await request
        .post('/flowsheet/join')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id, show_name: 'BS3461 open', specialty_id: specialtyIds.active })
        .expect(200);

      const res = await request.get('/flowsheet').query({ limit: 2 }).expect(200);

      expect(res.body.entries.map((e) => e.show_id).sort()).toEqual([showIds.active, showIds.untagged].sort());
      const byId = Object.fromEntries(res.body.shows.map((s) => [s.id, s]));
      expect(Object.keys(byId).map(Number).sort()).toEqual([showIds.active, showIds.untagged, joined.body.id].sort());
      expect(byId[showIds.active].specialty).toMatchObject(expectedRef('active', 'bs3454-active'));
      expect(byId[showIds.untagged].specialty).toBeNull();
      expect(byId[joined.body.id]).toMatchObject({
        show_name: 'BS3461 open',
        specialty: { slug: 'bs3454-active' },
        end_time: null,
      });
    });
  });
});
