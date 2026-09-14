const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest, expectErrorContains } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Seeded library row (dev_env/seed_db.sql) also used by library.spec.js's
// POST /library/rotation suite.
const SEED_ALBUM_ID = 2;

/**
 * Rotation Cards (BS#2472): GET/POST /library/rotation/cards,
 * PATCH/DELETE /library/rotation/cards/:id, plus `POST /library/rotation`'s
 * card wiring — newest-card defaulting when `card_id` is omitted and the
 * card-bin invariant (409 `rotation_card_bin_mismatch`) when it names a
 * card in a different bin. `assignCard`'s direct SQL UPDATE remains for the
 * cases that need a row filed WITHOUT going through the add path (e.g. onto
 * a non-newest card).
 *
 * Every test picks its own bin ('S' — Singles is the lightest-used bin in
 * the seed fixture) so this suite's cards and the grouped active_count they
 * accumulate don't collide with rows other specs create in 'M'/'L'/'H'.
 * (The one exception: the backfilled-card defaulting test reads bin 'L',
 * where migration 0165's card 1 is the only card because this suite never
 * creates one there.)
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

  // A kill dated in the FUTURE: the row is still rotating until that date,
  // so it must stay active under the canonical predicate
  // (`kill_date IS NULL OR kill_date > CURRENT_DATE`) — the discriminating
  // case the narrow `kill_date IS NULL` spelling gets wrong. `PATCH
  // /library/rotation` can't produce it (it kills at CURRENT_DATE, which
  // both spellings agree is inactive), hence raw SQL.
  async function scheduleKill(rotationId) {
    const sql = getTestDb();
    await sql`UPDATE ${sql(SCHEMA)}.rotation SET kill_date = CURRENT_DATE + INTERVAL '30 days' WHERE id = ${rotationId}`;
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

    test('returns 400 (not 500) for a body-less POST', async () => {
      // Express 5 + body-parser 2.x leave req.body UNDEFINED with no body.
      const res = await auth.post('/library/rotation/cards').expect(400);
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

    test('a FUTURE-dated kill still counts in active_count (canonical predicate, not kill_date IS NULL)', async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(card.body.id);

      const row = await auth.post('/library/rotation').send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S' }).expect(201);
      createdRotationIds.push(row.body.id);
      await assignCard(row.body.id, card.body.id);
      await scheduleKill(row.body.id);

      const list = await auth.get('/library/rotation/cards').expect(200);
      const listed = list.body.find((c) => c.id === card.body.id);
      expect(listed.active_count).toBe(1);
    });

    /**
     * BS#2479 AC: the per-card active-count query (`deleteRotationCardFromDB`'s
     * guard subquery, mirrored by `listRotationCardsFromDB`'s JOIN condition —
     * both filter `rotation.card_id = <card>` AND the canonical active
     * predicate) must be answerable by migration 0167's non-partial
     * `rotation_card_id_full_idx (card_id)`. 0164's original
     * `rotation_card_id_idx`, partial on `kill_date IS NULL`, could never serve
     * this query: the canonical predicate (`kill_date IS NULL OR kill_date >
     * CURRENT_DATE`) does not imply the narrower partial predicate, so
     * Postgres could not prove the index applicable and fell back to a full
     * scan of `rotation` on every delete-guard check and every cards listing.
     * Plain, not a `(card_id, kill_date)` composite — measured against a
     * prod-shaped clone (the migration's own header has the numbers), the
     * composite loses on the listing's GROUP BY query because the extra
     * column widens every leaf entry of an index that query scans in full.
     *
     * `enable_seqscan = off` inside a ROLLED-BACK transaction neutralizes the
     * tiny-test-dataset confounder (same pattern as
     * `flowsheet-upcoming-show-support.spec.js` /
     * `concerts-artist-lml-resolver-writer.spec.js`): the absence of a Seq
     * Scan node is the "index-supported" proof, since a small table would
     * otherwise make a seq scan cheaper regardless of index availability.
     */
    test('EXPLAIN: the per-card active-count query is index-supported (no seq scan) at production scale', async () => {
      const sql = getTestDb();
      let planJson;
      const sentinel = new Error('rollback-explain-probe');
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL enable_seqscan = off`);
          const rows = await tx.unsafe(
            `EXPLAIN (FORMAT JSON)
             SELECT count(*)::int
             FROM "${SCHEMA}".rotation
             WHERE "card_id" = 1
               AND ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)`
          );
          planJson = JSON.stringify(rows[0]['QUERY PLAN']);
          throw sentinel;
        });
      } catch (err) {
        if (err !== sentinel) throw err;
      }
      expect(planJson).toContain('"Relation Name":"rotation"');
      expect(planJson).not.toContain('"Node Type":"Seq Scan"');
      expect(planJson).toContain('rotation_card_id_full_idx');
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
    test('409s (card_not_highest_in_bin) unless the card is the highest-numbered in its bin', async () => {
      const lower = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(lower.body.id);
      const higher = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(higher.body.id);

      const res = await auth.delete(`/library/rotation/cards/${lower.body.id}`).expect(409);
      expect(res.body.reason).toBe('card_not_highest_in_bin');

      // The top of the bin deletes fine; remove it from the cleanup list so
      // afterEach doesn't try to delete it again.
      await auth.delete(`/library/rotation/cards/${higher.body.id}`).expect(204);
      createdCardIds.splice(createdCardIds.indexOf(higher.body.id), 1);
    });

    test('409s (card_has_active_rotations) while an active rotation row is assigned to the card', async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(card.body.id);

      const row = await auth.post('/library/rotation').send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S' }).expect(201);
      createdRotationIds.push(row.body.id);
      await assignCard(row.body.id, card.body.id);

      const blocked = await auth.delete(`/library/rotation/cards/${card.body.id}`).expect(409);
      expect(blocked.body.reason).toBe('card_has_active_rotations');

      await auth.patch('/library/rotation').send({ rotation_id: row.body.id }).expect(200);

      await auth.delete(`/library/rotation/cards/${card.body.id}`).expect(204);
      createdCardIds.splice(createdCardIds.indexOf(card.body.id), 1);
    });

    test('a FUTURE-dated kill still blocks deletion (canonical predicate, not kill_date IS NULL)', async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(card.body.id);

      const row = await auth.post('/library/rotation').send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S' }).expect(201);
      createdRotationIds.push(row.body.id);
      await assignCard(row.body.id, card.body.id);
      await scheduleKill(row.body.id);

      // The record is still on the shelf until the scheduled date; deleting
      // its card would ON-DELETE-SET-NULL a row DJs are still routed to.
      const blocked = await auth.delete(`/library/rotation/cards/${card.body.id}`).expect(409);
      expect(blocked.body.reason).toBe('card_has_active_rotations');
    });

    test('returns 400 (not 500) for a body-less rename PATCH', async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(card.body.id);

      const res = await auth.patch(`/library/rotation/cards/${card.body.id}`).expect(400);
      expectErrorContains(res, 'Missing Parameters: name');
    });
  });

  // BS#2472 AC 3-4: `POST /library/rotation`'s card wiring.
  describe('POST /library/rotation card filing', () => {
    test("defaults a card-less add onto the bin's newest card", async () => {
      const older = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(older.body.id);
      const newest = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(newest.body.id);

      const row = await auth.post('/library/rotation').send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S' }).expect(201);
      createdRotationIds.push(row.body.id);

      expect(row.body.card_id).toBe(newest.body.id);
    });

    test("a bin this suite created no cards in defaults onto the bin's backfilled card", async () => {
      // Migration 0165 seeded card 1 in EVERY bin and filed the bin's active
      // rows onto it, so post-backfill a card-less add always finds a card —
      // here bin 'L''s highest-numbered card, which is the backfilled one
      // unless an operator has since added more. (The empty-bin arm — row
      // lands unfiled — needs a bin's cards all deleted first; it is pinned
      // at the unit level in library.service.rotationCards.test.ts.)
      const cards = await auth.get('/library/rotation/cards').expect(200);
      const binCards = cards.body.filter((c) => c.bin === 'L');
      expect(binCards.length).toBeGreaterThan(0);
      const newest = binCards.reduce((a, b) => (b.number > a.number ? b : a));

      const row = await auth.post('/library/rotation').send({ album_id: SEED_ALBUM_ID, rotation_bin: 'L' }).expect(201);
      createdRotationIds.push(row.body.id);

      expect(row.body.card_id).toBe(newest.id);
    });

    test("accepts an explicit card_id whose card lives in the row's bin", async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(card.body.id);

      const row = await auth
        .post('/library/rotation')
        .send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S', card_id: card.body.id })
        .expect(201);
      createdRotationIds.push(row.body.id);

      expect(row.body.card_id).toBe(card.body.id);
    });

    test('409s (rotation_card_bin_mismatch) when the card lives in a different bin', async () => {
      const card = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
      createdCardIds.push(card.body.id);

      const res = await auth
        .post('/library/rotation')
        .send({ album_id: SEED_ALBUM_ID, rotation_bin: 'M', card_id: card.body.id })
        .expect(409);

      expect(res.body.reason).toBe('rotation_card_bin_mismatch');
    });

    test('404s a card_id that references no card', async () => {
      await auth
        .post('/library/rotation')
        .send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S', card_id: 999999999 })
        .expect(404);
    });

    test('400s a non-positive card_id', async () => {
      const res = await auth
        .post('/library/rotation')
        .send({ album_id: SEED_ALBUM_ID, rotation_bin: 'S', card_id: 0 })
        .expect(400);
      expectErrorContains(res, 'card_id must be a positive integer');
    });
  });
});
