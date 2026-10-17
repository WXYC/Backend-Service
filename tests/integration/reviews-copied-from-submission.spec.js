/**
 * `reviews.copied_from_submission_id` is the form-archive review a music director's copy of it came from (BS#3428).
 * `POST /reviews` takes it as an on-behalf key and stores it; like `imported_from_submission_id` (BS#3132) it is
 * internal, so no response carries it and `PATCH /reviews/{id}` cannot change it. Real Postgres, seeded through
 * tests/utils/intake_seed.js. As in reviews.spec.js, the CI containers run AUTH_BYPASS=true: `manager` is the seeded
 * station manager (`reviews: manage`) and `dj` is a raw user-id Bearer, a non-manager acting as that id. The grants
 * themselves are pinned by tests/unit/routes/reviews-permissions.route.test.ts; what this tier pins is the SQL: the
 * existence check, the foreign key and its `ON DELETE SET NULL`.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  removeSeededIntakeItems,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedFormSubmission,
  removeSeededFormSubmissions,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-COPIED-FROM';
/** The largest int4: a valid key that no `album_review_submissions` row has. */
const NO_SUCH_SUBMISSION = 2147483647;

describe('POST /reviews records the form review a copy came from (BS#3428)', () => {
  let manager;
  let dj;
  let sql;
  let submission;
  let release;

  const item = (key) => seedIntakeItem({ artist_name: `${PREFIX} ${key}` });
  const written = (target) =>
    target.album_id === undefined
      ? sql.unsafe(`SELECT * FROM "${SCHEMA}".reviews WHERE intake_item_id = $1 ORDER BY id`, [target.intake_item_id])
      : sql.unsafe(`SELECT * FROM "${SCHEMA}".reviews WHERE album_id = $1 ORDER BY id`, [target.album_id]);
  const copy = (client, target, copied_from_submission_id) =>
    client.post('/reviews').send({
      ...target,
      author: `${PREFIX} author`,
      review: 'A copied review.',
      accept: false,
      copied_from_submission_id,
    });

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await removeSeededIntakeItems();
    await removeSeededLibraryReleases();
    await removeSeededFormSubmissions();
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    dj = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    sql = getTestDb();
    await cleanup();
    submission = await seedFormSubmission();
    release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` });
  });

  afterAll(cleanup);

  test.each([
    ['a manage caller sending an existing form row', 'manager', 'item', () => submission.id, 200],
    ['a DJ sending it', 'dj', 'item', () => submission.id, 403],
    ['an id naming no form review', 'manager', 'item', () => NO_SUCH_SUBMISSION, 400],
    ['an album_id subject', 'manager', 'release', () => submission.id, 400],
    ['a string', 'manager', 'item', () => `${submission.id}`, 400],
    ['a fraction', 'manager', 'item', () => 1.5, 400],
    ['zero', 'manager', 'item', () => 0, 400],
    ['a negative', 'manager', 'item', () => -1, 400],
    ['null', 'manager', 'item', () => null, 400],
  ])('%s is a %i', async (label, caller, kind, value, status) => {
    const target = kind === 'release' ? { album_id: release.id } : { intake_item_id: (await item(label)).id };
    // A DJ sends only the key, so the 403 is the key's; `accept` belongs to an item subject, and sent with a release
    // it would be the 400, leaving that row proving nothing about the key.
    const body = {
      ...target,
      review: 'A copied review.',
      ...(caller === 'manager' ? { author: `${PREFIX} author`, ...(kind === 'item' ? { accept: false } : {}) } : {}),
      copied_from_submission_id: value(),
    };

    const res = await (caller === 'manager' ? manager : dj).post('/reviews').send(body);

    expect(res.status).toBe(status);
    expect(res.body).not.toHaveProperty('copied_from_submission_id');
    expect((await written(target)).map((row) => row.copied_from_submission_id)).toEqual(
      status === 200 ? [submission.id] : []
    );
  });

  test('deleting the form row nulls the column and keeps the review', async () => {
    const source = await seedFormSubmission();
    const target = { intake_item_id: (await item('delete')).id };
    const created = await copy(manager, target, source.id).expect(200);

    await sql`DELETE FROM ${sql(SCHEMA)}.album_review_submissions WHERE id = ${source.id}`;

    const rows = await written(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.body.id, review: 'A copied review.', copied_from_submission_id: null });
  });

  test('one form review can be copied onto two records', async () => {
    const first = { intake_item_id: (await item('two-formats-a')).id };
    const second = { intake_item_id: (await item('two-formats-b')).id };

    await copy(manager, first, submission.id).expect(200);
    await copy(manager, second, submission.id).expect(200);

    expect((await written(first))[0].copied_from_submission_id).toBe(submission.id);
    expect((await written(second))[0].copied_from_submission_id).toBe(submission.id);
  });

  test('PATCH /reviews/{id} cannot change it', async () => {
    const other = await seedFormSubmission();
    const target = { intake_item_id: (await item('patch')).id };
    const created = await copy(manager, target, submission.id).expect(200);

    await manager
      .patch(`/reviews/${created.body.id}`)
      .send({ review: 'Edited.', copied_from_submission_id: other.id })
      .expect(200);

    const [row] = await written(target);
    expect(row).toMatchObject({ review: 'Edited.', copied_from_submission_id: submission.id });
  });
});
