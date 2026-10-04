/**
 * `POST /reviews` and `PATCH /reviews/{id}` (BS#2802, slice 10a of BS#2791). Real Postgres,
 * direct SQL seeds. As in intake-transitions.spec.js, the CI containers run AUTH_BYPASS=true, so
 * the route grants are pinned by tests/unit/routes/reviews-permissions.route.test.ts; what this
 * tier pins is the SQL: the hold check, the author snapshot, the locked join and the draft
 * privacy of the response. `djA` is a raw user-id Bearer (a non-manager acting as that id).
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { seedIntakeItem, managerAccessToken } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-REVIEWS';

describe('/reviews create and edit (BS#2802)', () => {
  let manager;
  let djA;
  let djB;
  let sql;
  let libraryId;

  const heldItem = async (key, by = global.primary_dj_id) =>
    (
      await seedIntakeItem({
        artist_name: `${PREFIX} ${key}`,
        state: 'checked_out',
        checked_out_by: by,
        checked_out_at: new Date().toISOString(),
      })
    ).id;
  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author_user_id = ANY($1)`, [
      [global.primary_dj_id, global.secondary_dj_id],
    ]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title = $1`, [`${PREFIX} release`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name = $1 AND code_letters = 'ZY'`, [PREFIX]);
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    djB = createAuthRequest(request, global.secondary_access_token);
    sql = getTestDb();
    await cleanup();
    const [{ id: formatId }] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".format ORDER BY id LIMIT 1`);
    const [genre] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".genres ORDER BY id LIMIT 1`);
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters) VALUES ($1, $1, 'ZY') RETURNING id`,
      [PREFIX]
    );
    const [lib] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, 9104, $5) RETURNING id`,
      [artist.id, genre.id, formatId, `${PREFIX} release`, PREFIX]
    );
    libraryId = lib.id;
  });

  afterAll(cleanup);

  test('a DJ creates a draft on an item they hold: 200, typed, authored by them', async () => {
    const itemId = await heldItem('held');
    const res = await djA.post('/reviews').send({ intake_item_id: itemId, review: 'Lovely.', credit: 'dj_name' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intake_item_id: itemId,
      album_id: null,
      status: 'draft',
      medium: 'typed',
      author_user_id: global.primary_dj_id,
      review: 'Lovely.',
      credit: 'dj_name',
      locked: false,
    });
    expect([...res.body.author].length).toBeLessThanOrEqual(128);
  });

  test('a DJ cannot create a review on an item someone else holds, a pooled item, or a missing one', async () => {
    const theirs = await heldItem('theirs', global.secondary_dj_id);
    const pooled = (await seedIntakeItem({ artist_name: `${PREFIX} pool` })).id;
    for (const intake_item_id of [theirs, pooled, 2147483647]) {
      const res = await djA.post('/reviews').send({ intake_item_id });
      expect([res.status, res.body.reason]).toEqual([409, 'subject_not_held']);
    }
  });

  test('any DJ may review a library release; a missing release is 409', async () => {
    expect((await djA.post('/reviews').send({ album_id: libraryId })).status).toBe(200);
    expect((await djA.post('/reviews').send({ album_id: 2147483647 })).body.reason).toBe('subject_not_held');
  });

  test("another DJ's draft is a 404 to everyone else, a music director included", async () => {
    const { body } = await djA.post('/reviews').send({ album_id: libraryId });
    expect((await djB.patch(`/reviews/${body.id}`).send({ fcc: 'x' })).status).toBe(404);
    expect((await manager.patch(`/reviews/${body.id}`).send({ fcc: 'x' })).status).toBe(404);
  });

  describe('after submit (seeded directly; submit is BS#2854)', () => {
    const submit = (id) =>
      sql.unsafe(`UPDATE "${SCHEMA}".reviews SET status = 'submitted', submitted_at = now() WHERE id = $1`, [id]);

    test('the author edits before print, is locked after, and a music director still may', async () => {
      const itemId = await heldItem('print');
      const { body } = await djA.post('/reviews').send({ intake_item_id: itemId, review: 'First.' });
      await submit(body.id);
      expect((await djA.patch(`/reviews/${body.id}`).send({ review: 'Second.' })).status).toBe(200);
      expect((await djB.patch(`/reviews/${body.id}`).send({ review: 'Nope.' })).status).toBe(403);

      await sql.unsafe(`UPDATE "${SCHEMA}".intake_items SET printed_at = now() WHERE id = $1`, [itemId]);
      const locked = await djA.patch(`/reviews/${body.id}`).send({ review: 'Third.' });
      expect([locked.status, locked.body.reason]).toEqual([409, 'locked']);
      const md = await manager.patch(`/reviews/${body.id}`).send({ review: 'MD fix.' });
      expect([md.status, md.body.review, md.body.locked]).toEqual([200, 'MD fix.', true]);
    });

    test('the author edits their own library-release review after submit; nulling a typed review text is 400', async () => {
      const { body } = await djA.post('/reviews').send({ album_id: libraryId, review: 'Fine.' });
      await submit(body.id);
      expect((await djA.patch(`/reviews/${body.id}`).send({ buzzwords: 'warm' })).body.buzzwords).toBe('warm');
      expect((await djA.patch(`/reviews/${body.id}`).send({ review: '  ' })).status).toBe(400);
    });
  });
});
