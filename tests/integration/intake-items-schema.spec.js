/**
 * Integration tests for the `intake_items` / `intake_item_passes` schema
 * (slice 5 of WXYC/Backend-Service#2791, issue #2794), against a real
 * Postgres. The unit tier cannot see any of this: it is all constraint
 * behaviour the database enforces.
 *
 *   - the two CHECKs (citation exclusivity; filed/finalized requires
 *     `album_id`),
 *   - `album_id` cascading when its release is deleted,
 *   - `cited_album_id` nulling instead, so deleting the cited release never
 *     takes the item with it,
 *   - every `auth_user` attribution nulling when the account is deleted, and
 *     `intake_item_passes` cascading with its item or its DJ.
 *
 * Seeds and asserts through the `getTestDb()` pool; every row is removed in
 * `afterEach`.
 */

const { getTestDb } = require('../utils/db');
const { seedAuthUser, removeSeededAuthUsers, seedIntakeItem } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE_ID = 11; // exists in the integration fixture
const FORMAT_ID = 1;

describe('intake_items schema (real PG)', () => {
  let sql;
  let artistId;
  const libraryIds = [];
  const submissionIds = [];

  const seedUser = async () => (await seedAuthUser()).id;

  const seedLibrary = async (title) => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (${artistId}, ${GENRE_ID}, ${FORMAT_ID}, ${title}, 1)
      RETURNING id
    `;
    libraryIds.push(row.id);
    return row.id;
  };

  const seedSubmission = async () => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.album_review_submissions (artist_name, album_title)
      VALUES ('Juana Molina', 'DOGA')
      RETURNING id
    `;
    submissionIds.push(row.id);
    return row.id;
  };

  /** Insert an item; `extra` is a column → value map layered over the NOT NULLs. */
  const insertItem = (extra = {}) => seedIntakeItem(extra);

  const getItem = async (id) => (await sql`SELECT * FROM ${sql(SCHEMA)}.intake_items WHERE id = ${id}`)[0];

  beforeAll(async () => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    const [a] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES ('Jessica Pratt', 'Pratt, Jessica', 'PR')
      RETURNING id
    `;
    artistId = a.id;
  });

  afterEach(async () => {
    // Items first: `album_id` cascades, but `cited_album_id` and the user
    // columns only null, and a lingering item would hold the parents.
    await sql`DELETE FROM ${sql(SCHEMA)}.intake_items WHERE artist_name = 'Jessica Pratt'`;
    if (submissionIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.album_review_submissions WHERE id = ANY(${submissionIds})`;
    }
    if (libraryIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
    }
    await removeSeededAuthUsers();
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${artistId}`;
    submissionIds.length = 0;
    libraryIds.length = 0;
  });

  it('defaults a new item to the pool state', async () => {
    const item = await insertItem();
    expect(item.state).toBe('pool');
    expect(item.logged_at).toBeInstanceOf(Date);
  });

  describe('CHECK constraints', () => {
    it('rejects an item citing both a release and a form submission', async () => {
      const cited = await seedLibrary('cited');
      const submission = await seedSubmission();
      await expect(insertItem({ cited_album_id: cited, cited_submission_id: submission })).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'intake_items_citation_exclusive_ck',
      });
    });

    it.each([['cited_album_id'], ['cited_submission_id']])('accepts a citation through %s alone', async (column) => {
      const target = column === 'cited_album_id' ? await seedLibrary('cited') : await seedSubmission();
      const item = await insertItem({ [column]: target });
      expect(item[column]).toBe(target);
    });

    it.each([['filed'], ['finalized']])('rejects state %s without an album_id', async (state) => {
      await expect(insertItem({ state })).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'intake_items_filed_requires_album_ck',
      });
    });

    it('rejects moving a pooled item to filed before it has an album_id', async () => {
      const item = await insertItem();
      await expect(
        sql`UPDATE ${sql(SCHEMA)}.intake_items SET state = 'filed' WHERE id = ${item.id}`
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'intake_items_filed_requires_album_ck' });
    });

    it.each([['filed'], ['finalized']])('accepts state %s once album_id is set', async (state) => {
      const albumId = await seedLibrary('filed');
      const item = await insertItem({ state, album_id: albumId });
      expect(item.state).toBe(state);
    });
  });

  describe('library foreign keys', () => {
    it('deletes the item with the release it was filed as (album_id CASCADE)', async () => {
      const albumId = await seedLibrary('filed');
      const item = await insertItem({ state: 'filed', album_id: albumId });

      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ${albumId}`;

      expect(await getItem(item.id)).toBeUndefined();
    });

    it('keeps the item when the release it cited is deleted (cited_album_id SET NULL)', async () => {
      const cited = await seedLibrary('cited');
      const item = await insertItem({ cited_album_id: cited });

      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ${cited}`;

      expect((await getItem(item.id)).cited_album_id).toBeNull();
    });

    it('keeps the item when the form submission it cited is deleted (cited_submission_id SET NULL)', async () => {
      const submission = await seedSubmission();
      const item = await insertItem({ cited_submission_id: submission });

      await sql`DELETE FROM ${sql(SCHEMA)}.album_review_submissions WHERE id = ${submission}`;

      expect((await getItem(item.id)).cited_submission_id).toBeNull();
    });
  });

  describe('auth_user foreign keys', () => {
    const ATTRIBUTIONS = ['logged_by', 'requested_dj_id', 'checked_out_by', 'filed_by', 'printed_by', 'finalized_by'];

    it.each(ATTRIBUTIONS.map((c) => [c]))('nulls %s when the account is deleted', async (column) => {
      const userId = await seedUser();
      const item = await insertItem({ [column]: userId });

      await sql`DELETE FROM auth_user WHERE id = ${userId}`;

      const after = await getItem(item.id);
      expect(after).toBeDefined();
      expect(after[column]).toBeNull();
    });

    it('lets one deleted account clear every attribution on an item at once', async () => {
      const userId = await seedUser();
      const item = await insertItem(Object.fromEntries(ATTRIBUTIONS.map((c) => [c, userId])));

      await sql`DELETE FROM auth_user WHERE id = ${userId}`;

      const after = await getItem(item.id);
      expect(ATTRIBUTIONS.map((c) => after[c])).toEqual(ATTRIBUTIONS.map(() => null));
    });
  });

  describe('intake_item_passes', () => {
    const insertPass = async (itemId, djId) => {
      await sql`
        INSERT INTO ${sql(SCHEMA)}.intake_item_passes (intake_item_id, dj_id) VALUES (${itemId}, ${djId})
      `;
    };
    const passesFor = (itemId) => sql`SELECT * FROM ${sql(SCHEMA)}.intake_item_passes WHERE intake_item_id = ${itemId}`;

    it('drops the passes with their item', async () => {
      const item = await insertItem();
      await insertPass(item.id, await seedUser());

      await sql`DELETE FROM ${sql(SCHEMA)}.intake_items WHERE id = ${item.id}`;

      expect(await passesFor(item.id)).toHaveLength(0);
    });

    it("drops a DJ's passes with the DJ's account, leaving the item", async () => {
      const item = await insertItem();
      const userId = await seedUser();
      await insertPass(item.id, userId);

      await sql`DELETE FROM auth_user WHERE id = ${userId}`;

      expect(await passesFor(item.id)).toHaveLength(0);
      expect(await getItem(item.id)).toBeDefined();
    });
  });
});
