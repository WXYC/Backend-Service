/**
 * Integration tests for `review_revisions`, `review_prints`, `fcc_notes` and the
 * accepted-review columns on `intake_items` (slice 9b of
 * WXYC/Backend-Service#2791, issue #2858), against a real Postgres. The unit
 * tier cannot see any of this: it is all constraint behaviour the database
 * enforces.
 *
 *   - `review_prints_target_ck` and `fcc_notes_target_ck`,
 *   - `UNIQUE (review_id, revision)`,
 *   - each CASCADE and each SET NULL the issue lists,
 *   - the reviews <-> intake_items cycle: deleting an item whose
 *     `accepted_review_id` points at one of its own reviews succeeds and
 *     removes both.
 *
 * Seeds and asserts through the `getTestDb()` pool; every row is removed in
 * `afterEach`.
 */

const { getTestDb } = require('../utils/db');
const { seedAuthUser, removeSeededAuthUsers, seedIntakeItem } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE_ID = 11; // exists in the integration fixture
const FORMAT_ID = 1;
// Scopes this spec's items, so a sibling spec running in parallel never has its rows deleted.
const ITEM_ARTIST = 'BS#2858 Cat Power';

describe('review_revisions, review_prints, fcc_notes (real PG)', () => {
  let sql;
  let artistId;
  const libraryIds = [];

  const t = (name) => sql`${sql(SCHEMA)}.${sql(name)}`;

  const seedLibrary = async (title) => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (${artistId}, ${GENRE_ID}, ${FORMAT_ID}, ${title}, 1)
      RETURNING id
    `;
    libraryIds.push(row.id);
    return row.id;
  };

  const seedReview = async (columns) => {
    const [row] = await sql`INSERT INTO ${t('reviews')} ${sql(columns)} RETURNING id`;
    return row.id;
  };
  const seedRevision = async (columns) => {
    const [row] = await sql`INSERT INTO ${t('review_revisions')} ${sql({ revision: 1, ...columns })} RETURNING id`;
    return row.id;
  };
  const seedPrint = async (columns) => {
    const [row] = await sql`INSERT INTO ${t('review_prints')} ${sql(columns)} RETURNING id`;
    return row.id;
  };
  const seedNote = async (columns) => {
    const [row] = await sql`
      INSERT INTO ${t('fcc_notes')} ${sql({ track: 'la paradoja', note: 'a note', ...columns })} RETURNING id
    `;
    return row.id;
  };
  const getRow = async (name, id) => (await sql`SELECT * FROM ${t(name)} WHERE id = ${id}`)[0];

  beforeAll(async () => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    const [a] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES ('Juana Molina', 'Molina, Juana', 'MO')
      RETURNING id
    `;
    artistId = a.id;
  });

  afterEach(async () => {
    // Items and library rows cascade to everything below them; the accepted
    // pointer SETs NULL, so deleting items first is safe.
    await sql`DELETE FROM ${t('intake_items')} WHERE artist_name = ${ITEM_ARTIST}`;
    if (libraryIds.length > 0) {
      await sql`DELETE FROM ${t('library')} WHERE id = ANY(${libraryIds})`;
    }
    await removeSeededAuthUsers();
    await sql`DELETE FROM ${t('artists')} WHERE id = ${artistId}`;
    libraryIds.length = 0;
  });

  describe('CHECK constraints', () => {
    it('rejects a print with neither an item nor a release', async () => {
      await expect(sql`INSERT INTO ${t('review_prints')} DEFAULT VALUES`).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'review_prints_target_ck',
      });
    });

    it('rejects an FCC note with neither a release nor an item', async () => {
      await expect(seedNote({})).rejects.toMatchObject({ code: '23514', constraint_name: 'fcc_notes_target_ck' });
    });

    it('accepts a print for a release with no intake item', async () => {
      const printId = await seedPrint({ album_id: await seedLibrary('DOGA') });
      expect((await getRow('review_prints', printId)).intake_item_id).toBeNull();
    });

    it('accepts an FCC note on a pile item, defaulting its status to reported', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      const note = await getRow('fcc_notes', await seedNote({ intake_item_id: item.id }));
      expect(note.status).toBe('reported');
    });
  });

  describe('UNIQUE (review_id, revision)', () => {
    it('rejects a second copy of one revision number and accepts the next', async () => {
      const reviewId = await seedReview({ album_id: await seedLibrary('DOGA') });
      await seedRevision({ review_id: reviewId, revision: 1 });

      await expect(seedRevision({ review_id: reviewId, revision: 1 })).rejects.toMatchObject({
        code: '23505',
        constraint_name: 'review_revisions_review_id_revision_unique',
      });
      await expect(seedRevision({ review_id: reviewId, revision: 2 })).resolves.toBeDefined();
    });
  });

  describe('CASCADE', () => {
    it('deletes a review’s revisions with it', async () => {
      const reviewId = await seedReview({ album_id: await seedLibrary('DOGA') });
      const revisionId = await seedRevision({ review_id: reviewId });

      await sql`DELETE FROM ${t('reviews')} WHERE id = ${reviewId}`;

      expect(await getRow('review_revisions', revisionId)).toBeUndefined();
    });

    it.each([['review_prints'], ['fcc_notes']])('deletes %s with the release they name', async (name) => {
      const albumId = await seedLibrary('DOGA');
      const id = await (name === 'review_prints' ? seedPrint : seedNote)({ album_id: albumId });

      await sql`DELETE FROM ${t('library')} WHERE id = ${albumId}`;

      expect(await getRow(name, id)).toBeUndefined();
    });

    it.each([['review_prints'], ['fcc_notes']])('deletes %s with the intake item they name', async (name) => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      const id = await (name === 'review_prints' ? seedPrint : seedNote)({ intake_item_id: item.id });

      await sql`DELETE FROM ${t('intake_items')} WHERE id = ${item.id}`;

      expect(await getRow(name, id)).toBeUndefined();
    });
  });

  describe('SET NULL', () => {
    it('keeps a print when its review and revision are deleted', async () => {
      const albumId = await seedLibrary('DOGA');
      const reviewId = await seedReview({ album_id: albumId });
      const revisionId = await seedRevision({ review_id: reviewId });
      const printId = await seedPrint({ album_id: albumId, review_id: reviewId, revision_id: revisionId });

      await sql`DELETE FROM ${t('review_revisions')} WHERE id = ${revisionId}`;
      expect(await getRow('review_prints', printId)).toMatchObject({ review_id: reviewId, revision_id: null });

      await sql`DELETE FROM ${t('reviews')} WHERE id = ${reviewId}`;
      expect(await getRow('review_prints', printId)).toMatchObject({ review_id: null, revision_id: null });
    });

    it.each([
      ['review_revisions', 'edited_by_user_id'],
      ['review_prints', 'printed_by'],
      ['fcc_notes', 'reported_by_user_id'],
      ['intake_items', 'accepted_by'],
    ])('nulls %s.%s when the account is deleted', async (name, column) => {
      const userId = (await seedAuthUser()).id;
      const albumId = await seedLibrary('DOGA');
      const id = await {
        review_revisions: async () =>
          seedRevision({ review_id: await seedReview({ album_id: albumId }), [column]: userId }),
        review_prints: () => seedPrint({ album_id: albumId, [column]: userId }),
        fcc_notes: () => seedNote({ album_id: albumId, [column]: userId }),
        intake_items: async () => (await seedIntakeItem({ artist_name: ITEM_ARTIST, [column]: userId })).id,
      }[name]();

      await sql`DELETE FROM auth_user WHERE id = ${userId}`;

      const after = await getRow(name, id);
      expect(after).toBeDefined();
      expect(after[column]).toBeNull();
    });
  });

  describe('intake_items.accepted_review_id', () => {
    it('is NULL on a new item and takes the accept columns', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      expect(item).toMatchObject({ accepted_review_id: null, accepted_by: null, accepted_at: null });
    });

    it('nulls the pointer, keeping the item, when the accepted review is deleted', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      const reviewId = await seedReview({ intake_item_id: item.id });
      await sql`UPDATE ${t('intake_items')} SET accepted_review_id = ${reviewId} WHERE id = ${item.id}`;

      await sql`DELETE FROM ${t('reviews')} WHERE id = ${reviewId}`;

      expect(await getRow('intake_items', item.id)).toMatchObject({ accepted_review_id: null });
    });

    it('deletes an item whose accepted review is one of its own, removing both', async () => {
      const item = await seedIntakeItem({ artist_name: ITEM_ARTIST });
      const reviewId = await seedReview({ intake_item_id: item.id });
      await sql`UPDATE ${t('intake_items')} SET accepted_review_id = ${reviewId} WHERE id = ${item.id}`;

      await sql`DELETE FROM ${t('intake_items')} WHERE id = ${item.id}`;

      expect(await getRow('intake_items', item.id)).toBeUndefined();
      expect(await getRow('reviews', reviewId)).toBeUndefined();
    });
  });
});
