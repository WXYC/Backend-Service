/**
 * `GET /album-reviews` leaves out an archive row once `jobs/album-reviews-import` has copied it into `reviews`
 * (BS#3132): the review is then an ordinary review on its release, and listing the archive row too would show it twice.
 * A row the job skipped still lists. The exclusion keys on the live provenance column, so it lasts only while the
 * imported review does: once that review is deleted, the archive row lists again. Nothing is lost. After a release
 * delete, an intake item that had taken the imported review as its cover review also keeps its own copy; deleting the
 * imported review itself takes it off such an item and makes no copy. Rows come from `tests/utils/intake_seed.js`.
 *
 * The role gate is not asserted here: CI runs with AUTH_BYPASS=true. It is pinned in
 * `tests/unit/routes/album-reviews-permissions.route.test.ts`.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedFormSubmission,
  removeSeededFormSubmissions,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

describe('GET /album-reviews leaves out an imported row (BS#3132)', () => {
  let auth;
  let imported;
  let importedReview;
  let skipped;
  const artist = `Import Probe ${Date.now()}`;

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    const release = await seedLibraryRelease({ artist_name: artist });
    const form = { album_id: release.id, artist_name: artist, norm_artist: artist.toLowerCase() };
    imported = await seedFormSubmission({ ...form, review: 'Copied into reviews.' });
    skipped = await seedFormSubmission({ ...form, review: 'Left in the archive.' });
    importedReview = await seedReview({
      album_id: release.id,
      review: 'Copied into reviews.',
      imported_from_submission_id: imported.id,
    });
  });

  afterAll(async () => {
    await removeSeededFormSubmissions();
    await removeSeededLibraryReleases();
  });

  test.each([
    ['album_id', () => ({ album_id: String(imported.album_id) })],
    ['artist', () => ({ artist })],
  ])('lists the skipped row and not the imported one, by %s', async (_name, query) => {
    const res = await auth.get('/album-reviews').query({ ...query(), limit: 100 });

    expect(res.status).toBe(200);
    expect(res.body.album_reviews.map((row) => row.id)).toEqual([skipped.id]);
  });

  // Keep this last: it deletes the imported review the cases above depend on.
  test('lists the archive row again once its imported review is deleted', async () => {
    const sql = getTestDb();
    await sql`DELETE FROM ${sql(SCHEMA)}.reviews WHERE id = ${importedReview.id}`;

    const res = await auth.get('/album-reviews').query({ album_id: String(imported.album_id), limit: 100 });

    expect(res.status).toBe(200);
    expect(res.body.album_reviews.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [imported.id, skipped.id].sort((a, b) => a - b)
    );
  });
});
