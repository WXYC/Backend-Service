/**
 * Integration tests for restoring a release whose delete snapshot carries
 * `intake_items` and the extended `reviews` (slice 9 of
 * WXYC/Backend-Service#2791, issue #2801). A sibling of
 * library-restore-deleted.spec.js, which covers the restore endpoint's other
 * properties; these need a migrated Postgres because they depend on the real
 * FK checks no mocked transaction enforces:
 *
 *   1. a release filed from an intake item restores with the item and both of
 *      its reviews, and each review keeps its `intake_item_id` (the item
 *      replays before the reviews, which are captured through `album_id`);
 *   2. an `auth_user` reference whose account was removed between delete and
 *      restore restores as NULL, is reported as a `nulled` deviation carrying
 *      the removed id, and leaves the `author` text alone;
 *   3. an item that cites a release gone by restore time does the same for
 *      `cited_album_id`;
 *   4. a snapshot whose `reviews` row has the stub's old shape restores, the
 *      new columns taking their defaults;
 *   5. a snapshot with no `intake_items` key at all (every pre-0180 snapshot) restores;
 *   6. an item whose `format_id` target is gone answers 409
 *      `missing_reference` naming `intake_items`, writing nothing.
 *
 * Fixtures are scoped to a per-run marker; `catalog_delete_snapshot` is
 * permanently retained and shared with every other integration spec.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { seedAuthUser, removeSeededAuthUsers, seedIntakeItem } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ROCK = 11;
const FMT = 1; // 'cd'

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('POST /library/deleted/:batchId/restore with intake items and reviews (BS#2801)', () => {
  let auth;
  let sql;
  let artistId;
  const uniq = Date.now();
  const marker = `BS#2801 Restore ${uniq}`;
  const touchedAlbumIds = [];
  const createdFormatIds = [];
  let seq = 0;

  const createAlbum = async (overrides = {}) => {
    const created = await auth
      .post('/library')
      .send({
        album_title: `${marker} Release`,
        artist_id: artistId,
        label: marker,
        genre_id: ROCK,
        format_id: FMT,
        ...overrides,
      })
      .expect(201);
    touchedAlbumIds.push(created.body.id);
    return created.body;
  };

  const deleteAlbum = async (albumId) => {
    await auth.delete(`/library/${albumId}`).expect(204);
    const rows = await sql.unsafe(
      `SELECT batch_id FROM "${SCHEMA}".catalog_delete_snapshot
        WHERE entity_kind = 'library' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [albumId]
    );
    expect(rows).toHaveLength(1);
    return rows[0].batch_id;
  };

  /** A filed item for `albumId`; `extra` is a column -> value map layered over the seeder's NOT NULL defaults. */
  const insertFiledItem = async (albumId, extra = {}) => {
    const item = await seedIntakeItem({
      album_title: `${marker} Item`,
      state: 'filed',
      album_id: albumId,
      ...extra,
    });
    return item.id;
  };

  const insertReview = async (columns) => {
    const names = Object.keys(columns);
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".reviews (${names.join(', ')})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(columns)
    );
    return rows[0].id;
  };

  const readReviews = (albumId) =>
    sql.unsafe(`SELECT * FROM "${SCHEMA}".reviews WHERE album_id = $1 ORDER BY id`, [albumId]);

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();
    const artist = await auth
      .post('/library/artists')
      .send({
        artist_name: `${marker} Artist`,
        code_letters: 'B9',
        genre_id: ROCK,
        code_number: 9000 + (uniq % 500),
      })
      .expect(201);
    artistId = artist.body.id;
  });

  afterAll(async () => {
    if (!sql) return;
    try {
      if (touchedAlbumIds.length > 0) {
        // Items and reviews cascade away with their release.
        await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1::int[])`, [touchedAlbumIds]);
        await sql.unsafe(
          `DELETE FROM "${SCHEMA}".catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY($1::int[])`,
          [touchedAlbumIds]
        );
        await sql.unsafe(`DELETE FROM "${SCHEMA}".library_delete_denylist WHERE library_id = ANY($1::int[])`, [
          touchedAlbumIds,
        ]);
      }
      if (createdFormatIds.length > 0) {
        await sql.unsafe(`DELETE FROM "${SCHEMA}".format WHERE id = ANY($1::int[])`, [createdFormatIds]);
      }
      await removeSeededAuthUsers();
    } finally {
      await sql.end();
    }
  });

  test('restores a release filed from an intake item with its two reviews, each still pointing at the item', async () => {
    const album = await createAlbum({ album_title: `${marker} Filed` });
    const itemId = await insertFiledItem(album.id);
    const reviewIds = [
      await insertReview({ album_id: album.id, intake_item_id: itemId, review: 'la paradoja', author: 'Cat Power' }),
      await insertReview({ album_id: album.id, intake_item_id: itemId, review: 'Back, Baby', author: 'Stereolab' }),
    ];
    const batchId = await deleteAlbum(album.id);
    expect(await readReviews(album.id)).toHaveLength(0);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.entities[0].children).toMatchObject({ intake_items: 1, reviews: 2 });
    expect(res.body.entities[0].deviations).toEqual([]);
    const reviews = await readReviews(album.id);
    expect(reviews.map((review) => review.id)).toEqual(reviewIds);
    expect(reviews.map((review) => review.intake_item_id)).toEqual([itemId, itemId]);
    const items = await sql.unsafe(`SELECT album_id, state FROM "${SCHEMA}".intake_items WHERE id = $1`, [itemId]);
    expect(items).toEqual([expect.objectContaining({ album_id: album.id, state: 'filed' })]);
  });

  test('restores as NULL a review author whose account was removed after the delete, and reports it', async () => {
    const album = await createAlbum({ album_title: `${marker} Author Gone` });
    const authorId = (await seedAuthUser()).id;
    const reviewId = await insertReview({
      album_id: album.id,
      review: 'DOGA',
      author: 'Juana Molina',
      author_user_id: authorId,
    });
    const batchId = await deleteAlbum(album.id);
    await sql.unsafe(`DELETE FROM auth_user WHERE id = $1`, [authorId]);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.entities[0].children.reviews).toBe(1);
    expect(res.body.entities[0].deviations).toEqual([
      { kind: 'nulled', table: 'reviews', row_id: reviewId, column: 'author_user_id', captured_value: authorId },
    ]);
    const [review] = await readReviews(album.id);
    expect(review).toMatchObject({ author_user_id: null, author: 'Juana Molina' });
  });

  test('restores a filed item as NULL-cited when the release it cites is gone by restore time, and reports it', async () => {
    const album = await createAlbum({ album_title: `${marker} Citing` });
    const cited = await createAlbum({ album_title: `${marker} Cited` });
    const itemId = await insertFiledItem(album.id, { cited_album_id: cited.id });
    const batchId = await deleteAlbum(album.id);
    await deleteAlbum(cited.id);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.entities[0].children.intake_items).toBe(1);
    expect(res.body.entities[0].deviations).toEqual([
      {
        kind: 'nulled',
        table: 'intake_items',
        row_id: itemId,
        column: 'cited_album_id',
        captured_value: String(cited.id),
      },
    ]);
    const items = await sql.unsafe(`SELECT cited_album_id FROM "${SCHEMA}".intake_items WHERE id = $1`, [itemId]);
    expect(items).toEqual([{ cited_album_id: null }]);
  });

  test('restores a snapshot whose reviews row has the stub’s old shape, the new columns taking their defaults', async () => {
    const album = await createAlbum({ album_title: `${marker} Stub Shape` });
    const reviewId = await insertReview({
      album_id: album.id,
      review: 'On Your Own Love Again',
      author: 'Jessica Pratt',
    });
    const batchId = await deleteAlbum(album.id);

    // Rewrite the captured row to what a snapshot written before the migration
    // held: only the six stub columns.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".catalog_delete_snapshot
          SET captured = jsonb_set(captured, '{children,reviews}', (
            SELECT jsonb_agg(jsonb_build_object(
              'id', r->'id', 'album_id', r->'album_id', 'review', r->'review',
              'add_date', r->'add_date', 'last_modified', r->'last_modified', 'author', r->'author'))
              FROM jsonb_array_elements(captured->'children'->'reviews') AS r))
        WHERE batch_id = $1`,
      [batchId]
    );
    const [captured] = await sql.unsafe(
      `SELECT captured->'children'->'reviews'->0 AS review FROM "${SCHEMA}".catalog_delete_snapshot WHERE batch_id = $1`,
      [batchId]
    );
    expect(Object.keys(captured.review).sort()).toEqual([
      'add_date',
      'album_id',
      'author',
      'id',
      'last_modified',
      'review',
    ]);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.entities[0].children.reviews).toBe(1);
    const [review] = await readReviews(album.id);
    expect(review).toMatchObject({
      id: reviewId,
      status: 'submitted',
      medium: 'typed',
      publish_website: false,
      publish_apps: false,
      publish_instagram: false,
      credit: null,
      intake_item_id: null,
    });
  });

  test('restores a pre-0180 snapshot that has no intake_items key at all (not an empty one)', async () => {
    const album = await createAlbum({ album_title: `${marker} No Items Key` });
    const reviewId = await insertReview({
      album_id: album.id,
      review: 'Call Your Name',
      author: 'Chuquimamani-Condori',
    });
    const batchId = await deleteAlbum(album.id);

    // Every snapshot written before the migration lacks the key entirely.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".catalog_delete_snapshot
          SET captured = captured #- '{children,intake_items}'
        WHERE batch_id = $1`,
      [batchId]
    );
    const [probe] = await sql.unsafe(
      `SELECT captured->'children' ? 'intake_items' AS has_key FROM "${SCHEMA}".catalog_delete_snapshot WHERE batch_id = $1`,
      [batchId]
    );
    expect(probe.has_key).toBe(false);

    const res = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(200);

    expect(res.body.entities[0].children.reviews).toBe(1);
    expect(res.body.entities[0].deviations).toEqual([]);
    const [review] = await readReviews(album.id);
    expect(review.id).toBe(reviewId);
  });

  test('refuses with a named 409, writing nothing, when an item’s format is gone', async () => {
    const album = await createAlbum({ album_title: `${marker} Format Gone` });
    seq += 1;
    const [format] = await sql.unsafe(`INSERT INTO "${SCHEMA}".format (format_name) VALUES ($1) RETURNING id`, [
      `${marker} Format ${seq}`,
    ]);
    createdFormatIds.push(format.id);
    const itemId = await insertFiledItem(album.id, { format_id: format.id });
    const batchId = await deleteAlbum(album.id);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".format WHERE id = $1`, [format.id]);

    const refused = await auth.post(`/library/deleted/${batchId}/restore`).send({}).expect(409);

    expect(refused.body).toMatchObject({
      reason: 'missing_reference',
      table: 'intake_items',
      row_id: itemId,
      column: 'format_id',
      target_table: 'format',
      captured_value: String(format.id),
    });
    const rows = await sql.unsafe(`SELECT 1 FROM "${SCHEMA}".library WHERE id = $1`, [album.id]);
    expect(rows).toHaveLength(0);
  });
});
