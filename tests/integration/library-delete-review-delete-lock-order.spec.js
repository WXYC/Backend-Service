/**
 * `DELETE /library/{id}` against `DELETE /reviews/{id}` on a review whose intake item is filed as the
 * release (BS#2928, slice of BS#2791). The review delete locks the item and then the review; the
 * library delete used to lock the review (the capture's `FOR SHARE`) before the item, so the two could
 * meet in a lock cycle and the librarian got 503 `lock_unavailable`. The library delete now locks the
 * release's items first, so neither request may answer 503: each ends deleted or with its own
 * documented refusal. The two are started together, in both orders, and repeated, because the cycle
 * needs the statements to interleave.
 *
 * Rows come from `tests/utils/intake_seed.js`. `reviews:manage` is the station-manager fixture account.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-LOCK-ORDER';
const ROUNDS = 6;

describe('DELETE /library/:id and DELETE /reviews/:id do not deadlock (BS#2928)', () => {
  let manager;
  let sql;
  const releaseIds = [];

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    if (releaseIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY(${releaseIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library_delete_denylist WHERE library_id = ANY(${releaseIds})`;
    }
    await removeSeededLibraryReleases();
  };

  /** A release, an item filed as it, and a review of the release that the item accepted. */
  const seedPair = async () => {
    const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` });
    releaseIds.push(release.id);
    const item = await seedIntakeItem({ artist_name: `${PREFIX} item`, state: 'filed', album_id: release.id });
    const review = await seedReview({ album_id: release.id, author: `${PREFIX} author` });
    await sql.unsafe(`UPDATE "${SCHEMA}".intake_items SET accepted_review_id = $1 WHERE id = $2`, [review.id, item.id]);
    return { release, review };
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    sql = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  it.each([
    ['library delete first', true],
    ['review delete first', false],
  ])('neither answers 503 lock_unavailable when started together (%s)', async (_label, libraryFirst) => {
    for (let round = 0; round < ROUNDS; round++) {
      const { release, review } = await seedPair();
      const deleteRelease = () => manager.delete(`/library/${release.id}`);
      const deleteReview = () => manager.delete(`/reviews/${review.id}`);
      const [first, second] = await Promise.all(
        libraryFirst ? [deleteRelease(), deleteReview()] : [deleteReview(), deleteRelease()]
      );
      const [libraryRes, reviewRes] = libraryFirst ? [first, second] : [second, first];

      expect(libraryRes.status).not.toBe(503);
      expect(reviewRes.status).not.toBe(503);
      // Each is either done or refused on the merits: 204, or a 404/409 because the other ran first.
      expect([204, 404, 409]).toContain(libraryRes.status);
      expect([204, 404, 409]).toContain(reviewRes.status);
    }
  });
});
