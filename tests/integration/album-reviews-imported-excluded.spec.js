/**
 * `GET /album-reviews` leaves out an archive row once `jobs/album-reviews-import` has copied it into `reviews`
 * (BS#3132), and lists it again when that review is deleted; the rule is set out in ADR 0011
 * (docs/adr/0011-album-review-submissions-separate-archive.md). Rows come from `tests/utils/intake_seed.js`.
 *
 * The role gate is not asserted here: CI runs with AUTH_BYPASS=true. It is pinned in
 * `tests/unit/routes/album-reviews-permissions.route.test.ts`.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedLibraryRelease,
  seedIntakeItem,
  removeSeededIntakeItems,
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

describe('GET /album-reviews leaves out a row while a submitted copy of it is on its release (BS#3159)', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  afterAll(async () => {
    await removeSeededIntakeItems();
    await removeSeededFormSubmissions();
    await removeSeededLibraryReleases();
  });

  // `copy` returns the columns of the review seeded from the form row, or null to seed none.
  test.each([
    ['a submitted copy on its release', true, (form) => ({ album_id: form.album_id, status: 'submitted' })],
    ['a draft copy on its release', false, (form) => ({ album_id: form.album_id, status: 'draft' })],
    ['a copy on another release', false, async () => ({ album_id: (await seedLibraryRelease()).id })],
    ['a copy on an unfiled record', false, async () => ({ intake_item_id: (await seedIntakeItem()).id })],
    ['a copy that was deleted', false, (form) => ({ album_id: form.album_id, remove: true })],
    // An unfiled item citing the row is what the citation-keyed rule this replaced left the row out for.
    [
      'a citation with no copy',
      false,
      async (form) => {
        await seedIntakeItem({ cited_submission_id: form.id });
        return null;
      },
    ],
  ])('with %s, the row is left out: %s', async (_name, excluded, copy) => {
    const artist = `Copy Probe ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const release = await seedLibraryRelease({ artist_name: artist });
    const form = await seedFormSubmission({
      album_id: release.id,
      artist_name: artist,
      norm_artist: artist.toLowerCase(),
      review: 'Copied by a music director.',
    });
    const overrides = await copy(form);
    if (overrides !== null) {
      const { remove, ...columns } = overrides;
      const seeded = await seedReview({ copied_from_submission_id: form.id, ...columns });
      if (remove) {
        const sql = getTestDb();
        await sql`DELETE FROM ${sql(SCHEMA)}.reviews WHERE id = ${seeded.id}`;
      }
    }

    for (const query of [{ album_id: String(release.id) }, { artist }]) {
      const res = await auth.get('/album-reviews').query({ ...query, limit: 100 });

      expect(res.status).toBe(200);
      expect(res.body.album_reviews.map((row) => row.id)).toEqual(excluded ? [] : [form.id]);
    }
  });
});
