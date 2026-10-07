const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Seeded library row (dev_env/seed_db.sql), shared with rotation-cards.spec.js.
const SEED_ALBUM_ID = 2;

// Far enough in the past that no write in this suite could land on it, and
// distinct from NULL so "left untouched" and "stamped back to NULL" differ.
const SENTINEL = '2000-01-01T00:00:00.000Z';

/**
 * `rotation_cards.last_changed_at` is kept by two row triggers on `rotation`
 * (INSERT/DELETE, and UPDATE OF card_id/kill_date guarded by a WHEN clause).
 * `now()` is the transaction start time and cannot be pinned from Jest, so
 * every "stamps nothing" test pre-sets the column to SENTINEL and asserts it
 * is unchanged, and every "stamps" test asserts the value moved off SENTINEL
 * to at least a `clock_timestamp()` captured before the write.
 *
 * Cards live in bin 'S' (the lightest-used bin in the seed fixture), like
 * rotation-cards.spec.js.
 */
describe('rotation_cards.last_changed_at', () => {
  let auth;
  let sql;
  const createdCardIds = [];
  const createdRotationIds = [];

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
  });

  afterEach(async () => {
    if (createdRotationIds.length) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id IN ${sql(createdRotationIds)}`;
      createdRotationIds.length = 0;
    }
    if (createdCardIds.length) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation_cards WHERE id IN ${sql(createdCardIds)}`;
      createdCardIds.length = 0;
    }
  });

  async function newCard() {
    const res = await auth.post('/library/rotation/cards').send({ bin: 'S' }).expect(200);
    createdCardIds.push(res.body.id);
    return res.body.id;
  }

  async function insertRotationRow(cardId, killDate = null) {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin, card_id, kill_date)
      VALUES (${SEED_ALBUM_ID}, 'S', ${cardId}, ${killDate})
      RETURNING id
    `;
    createdRotationIds.push(row.id);
    return row.id;
  }

  async function setSentinel(...cardIds) {
    await sql`UPDATE ${sql(SCHEMA)}.rotation_cards SET last_changed_at = ${SENTINEL} WHERE id IN ${sql(cardIds)}`;
  }

  async function stamp(cardId) {
    const [row] = await sql`SELECT last_changed_at FROM ${sql(SCHEMA)}.rotation_cards WHERE id = ${cardId}`;
    return row.last_changed_at;
  }

  async function clockBefore() {
    const [row] = await sql`SELECT clock_timestamp() AS t`;
    return row.t;
  }

  async function expectStamped(cardId, notBefore) {
    const value = await stamp(cardId);
    expect(value).not.toBeNull();
    expect(value.toISOString()).not.toBe(SENTINEL);
    expect(value.getTime()).toBeGreaterThanOrEqual(notBefore.getTime());
  }

  async function expectUntouched(cardId) {
    expect((await stamp(cardId)).toISOString()).toBe(SENTINEL);
  }

  test('a new card reads null until something changes it', async () => {
    const cardId = await newCard();
    expect(await stamp(cardId)).toBeNull();
  });

  describe('INSERT', () => {
    test('stamps the card the new row is filed on', async () => {
      const cardId = await newCard();
      await setSentinel(cardId);
      const before = await clockBefore();

      await insertRotationRow(cardId);

      await expectStamped(cardId, before);
    });

    test('leaves every card untouched when the new row has no card', async () => {
      const cardId = await newCard();
      await setSentinel(cardId);

      await sql`
        INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin)
        VALUES (${SEED_ALBUM_ID}, 'S')
        RETURNING id
      `.then(([row]) => createdRotationIds.push(row.id));

      await expectUntouched(cardId);
    });
  });

  describe('UPDATE', () => {
    test('moving a row from card A to card B stamps both', async () => {
      const a = await newCard();
      const b = await newCard();
      const rowId = await insertRotationRow(a);
      await setSentinel(a, b);
      const before = await clockBefore();

      await auth.patch(`/library/rotation/${rowId}`).send({ card_id: b }).expect(200);

      await expectStamped(a, before);
      await expectStamped(b, before);
    });

    test('kill stamps the row card', async () => {
      const cardId = await newCard();
      const rowId = await insertRotationRow(cardId);
      await setSentinel(cardId);
      const before = await clockBefore();

      await auth.patch('/library/rotation').send({ rotation_id: rowId }).expect(200);

      await expectStamped(cardId, before);
    });

    test('unkill stamps the row card', async () => {
      const cardId = await newCard();
      const rowId = await insertRotationRow(cardId, '2020-01-01');
      await setSentinel(cardId);
      const before = await clockBefore();

      await auth.patch(`/library/rotation/${rowId}`).send({ kill_date: null }).expect(200);

      await expectStamped(cardId, before);
    });

    test('setting kill_date to its current value stamps nothing (the rotation-etl upsert shape)', async () => {
      const cardId = await newCard();
      const rowId = await insertRotationRow(cardId, '2020-01-01');
      await setSentinel(cardId);

      await sql`UPDATE ${sql(SCHEMA)}.rotation SET kill_date = kill_date, card_id = card_id WHERE id = ${rowId}`;
      await sql`UPDATE ${sql(SCHEMA)}.rotation SET kill_date = '2020-01-01' WHERE id = ${rowId}`;

      await expectUntouched(cardId);
    });

    test('updating an unrelated column stamps nothing', async () => {
      const cardId = await newCard();
      const rowId = await insertRotationRow(cardId);
      await setSentinel(cardId);

      await sql`UPDATE ${sql(SCHEMA)}.rotation SET artist_name = 'Unrelated Edit', rotation_bin = 'S' WHERE id = ${rowId}`;

      await expectUntouched(cardId);
    });
  });

  describe('DELETE', () => {
    test('deleting a rotation row stamps the card it leaves', async () => {
      const cardId = await newCard();
      const rowId = await insertRotationRow(cardId);
      await setSentinel(cardId);
      const before = await clockBefore();

      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ${rowId}`;
      createdRotationIds.splice(createdRotationIds.indexOf(rowId), 1);

      await expectStamped(cardId, before);
    });

    test('deleting a card that holds killed rows succeeds and uncards them', async () => {
      const cardId = await newCard();
      const rowId = await insertRotationRow(cardId, '2020-01-01');

      // The SET NULL cascade fires the UPDATE trigger for a card that is
      // already gone; the stamp matches zero rows and must not raise.
      await auth.delete(`/library/rotation/cards/${cardId}`).expect(204);
      createdCardIds.splice(createdCardIds.indexOf(cardId), 1);

      const [row] = await sql`SELECT card_id FROM ${sql(SCHEMA)}.rotation WHERE id = ${rowId}`;
      expect(row.card_id).toBeNull();
    });
  });

  describe('GET /library/rotation/cards', () => {
    test('emits last_changed_at: null for an untouched card and an ISO instant once stamped', async () => {
      const cardId = await newCard();

      const untouched = await auth.get('/library/rotation/cards').expect(200);
      expect(untouched.body.find((c) => c.id === cardId).last_changed_at).toBeNull();

      await insertRotationRow(cardId);

      const stamped = await auth.get('/library/rotation/cards').expect(200);
      const listed = stamped.body.find((c) => c.id === cardId);
      expect(typeof listed.last_changed_at).toBe('string');
      expect(new Date(listed.last_changed_at).toISOString()).toBe(listed.last_changed_at);
    });
  });
});
