/**
 * `reviews.imported_from_submission_id` is the album-reviews import's internal provenance (BS#3132). The contract's
 * `Review` does not carry it, so no `/reviews` read returns the key, for an imported review or any other. Every
 * response is built from one select list (`reviewSelection`, pinned in tests/unit/services/reviews-read.service.test.ts);
 * this tier reads an imported review back over HTTP. As in reviews-read.spec.js the CI containers run AUTH_BYPASS=true,
 * so the route grants are pinned by tests/unit/routes/reviews-permissions.route.test.ts. Rows come from
 * tests/utils/intake_seed.js.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const {
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedFormSubmission,
  removeSeededFormSubmissions,
  managerAccessToken,
} = require('../utils/intake_seed');

describe('/reviews responses leave out the import provenance (BS#3132)', () => {
  let manager;
  let release;
  let imported;
  let ordinary;

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    release = await seedLibraryRelease();
    const submission = await seedFormSubmission({ album_id: release.id });
    imported = await seedReview({
      album_id: release.id,
      review: 'Copied into reviews.',
      imported_from_submission_id: submission.id,
    });
    ordinary = await seedReview({ album_id: release.id, review: 'Written in the DJ site.' });
  });

  afterAll(async () => {
    await removeSeededLibraryReleases();
    await removeSeededFormSubmissions();
  });

  test('the by-id read returns the review without the key', async () => {
    const res = await manager.get(`/reviews/${imported.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: imported.id, review: 'Copied into reviews.' });
    expect(res.body).not.toHaveProperty('imported_from_submission_id');
  });

  test("the release's review list returns every review without the key", async () => {
    const res = await manager.get('/reviews').query({ album_id: release.id });

    expect(res.status).toBe(200);
    expect(res.body.map((review) => review.id).sort()).toEqual([imported.id, ordinary.id].sort());
    for (const review of res.body) expect(review).not.toHaveProperty('imported_from_submission_id');
  });
});
