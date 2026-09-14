const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Seeded library row (dev_env/seed_db.sql) also used by library.spec.js's
// POST /library/rotation suite.
const SEED_ALBUM_ID = 2;

/**
 * Rotation Cards (BS#2472): GET/POST /library/rotation/cards,
 * PATCH/DELETE /library/rotation/cards/:id. `POST /library/rotation` does
 * not yet accept `card_id` — that wiring (newest-card defaulting + the
 * card-bin invariant) is a follow-up (#2481), so a rotation row is assigned
 * to a card here via a direct SQL UPDATE, the same way a future backfill
 * would.
 *
 * Every test picks its own bin ('S' — Singles is the lightest-used bin in
 * the seed fixture) so this suite's cards and the grouped active_count they
 * accumulate don't collide with rows other specs create in 'M'/'L'/'H'.
 */
describe('Rotation Cards', () => {
  let auth;
  const createdCardIds = [];
  const createdRotationIds = [];

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  afterEach(async () => {
    const sql = getTestDb();
    if (createdRotationIds.length) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id IN ${sql(createdRotationIds)}`;
      createdRotationIds.length = 0;
    }
    if (createdCardIds.length) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation_cards WHERE id IN ${sql(createdCardIds)}`;
      createdCardIds.length = 0;
    }
  });

  async function assignCard(rotationId, cardId) {
    const sql = getTestDb();
    await sql`UPDATE ${sql(SCHEMA)}.rotation SET card_id = ${cardId} WHERE id = ${rotationId}`;
  }

  describe('POST /library/rotation/cards', () => {
    test('assigns number = current bin max + 1', async () => {
      const first = await auth.post('/library/rotation/cards').send({ bin: 'S', name: 'First' }).expect(200);
      createdCardIds.push(first.body.id);
      expect(first.body.bin).toBe('S');

      const second = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(second.body.id);

      expect(second.body.number).toBe(first.body.number + 1);
      expect(second.body.name).toBeNull();
    });

    test('returns 400 for an invalid bin', async () => {
      const res = await auth.post('/library/rotation/cards').send({ bin: 'X' }).expect(400);
      expectErrorContains(res, 'Invalid bin');
    });
  });

  describe('GET /library/rotation/cards', () => {
    test('active_count reflects only active rotation rows, via one grouped query', async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(card.body.id);

      const active = await auth
        .post('/library/rotation')
        .send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S' })
        .expect(201);
      createdRotationIds.push(active.body.id);
      await assignCard(active.body.id, card.body.id);

      const killed = await auth
        .post('/library/rotation')
        .send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S' })
        .expect(201);
      createdRotationIds.push(killed.body.id);
      await assignCard(killed.body.id, card.body.id);
      await auth.patch('/library/rotation').send({ rotation_id: killed.body.id }).expect(200);

      const list = await auth.get('/library/rotation/cards').expect(200);
      const row = list.body.find((c) => c.id === card.body.id);
      expect(row).toBeDefined();
      expect(row.active_count).toBe(1);
    });
  });

  describe('PATCH /library/rotation/cards/:id', () => {
    test('renames the card', async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S', name: 'Old' }).expect(200);
      createdCardIds.push(card.body.id);

      const renamed = await auth.patch(`/library/rotation/cards/${card.body.id}`).send({ name: 'New' }).expect(200);

      expect(renamed.body.name).toBe('New');
    });

    test('returns 404 for a nonexistent card', async () => {
      await auth.patch('/library/rotation/cards/999999999').send({ name: 'x' }).expect(404);
    });
  });

  describe('DELETE /library/rotation/cards/:id', () => {
    test('409s (not_last_in_bin) unless the card is the highest-numbered in its bin', async () => {
      const lower = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(lower.body.id);
      const higher = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(higher.body.id);

      const res = await auth.delete(`/library/rotation/cards/${lower.body.id}`).expect(409);
      expect(res.body.reason).toBe('card_not_last_in_bin');

      // The top of the bin deletes fine; remove it from the cleanup list so
      // afterEach doesn't try to delete it again.
      await auth.delete(`/library/rotation/cards/${higher.body.id}`).expect(204);
      createdCardIds.splice(createdCardIds.indexOf(higher.body.id), 1);
    });

    test('409s (has_active_rows) while an active rotation row is assigned to the card', async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(card.body.id);

      const row = await auth.post('/library/rotation').send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S' }).expect(201);
      createdRotationIds.push(row.body.id);
      await assignCard(row.body.id, card.body.id);

      const blocked = await auth.delete(`/library/rotation/cards/${card.body.id}`).expect(409);
      expect(blocked.body.reason).toBe('card_has_active_rows');

      await auth.patch('/library/rotation').send({ rotation_id: row.body.id }).expect(200);

      await auth.delete(`/library/rotation/cards/${card.body.id}`).expect(204);
      createdCardIds.splice(createdCardIds.indexOf(card.body.id), 1);
    });
  });
});
