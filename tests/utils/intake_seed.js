/**
 * Shared seeders for the intake and review integration specs (`tests/integration/intake-*.spec.js`,
 * `reviews*.spec.js` and `library-restore-*.spec.js`, and the slices that follow). `reviews.spec.js` and
 * `intake-items.spec.js` take their releases, reviews and form-archive reviews from here, and
 * `intake-seed.spec.js` covers the seeders themselves. A spec that needs a user, an intake item, a
 * library release, a review, a review revision, a print or an FCC note, or a form-archive review seeds it here and does not hand-write the INSERT.
 *
 * `auth_user` is better-auth's table and lives in the `public` schema, NOT in
 * `${WXYC_SCHEMA_NAME}` like every domain table. It is therefore written
 * unqualified here, and nowhere else should a spec hand-write
 * `INSERT INTO auth_user` (a `"wxyc_schema".auth_user` qualification fails
 * with "relation does not exist"). `intake_items`, `artists`, `library`, `genres`, `reviews`, `review_revisions`,
 * `review_prints`, `fcc_notes` and `album_review_submissions` are domain tables and are schema-qualified.
 *
 * Which seeders have a remover: users (`removeSeededAuthUsers`), releases and their artists
 * (`removeSeededLibraryReleases`) and form-archive reviews (`removeSeededFormSubmissions`). Intake items
 * (`seedIntakeItem`) have none: an item's cleanup is the caller's. Reviews (`seedReview`), revisions
 * (`seedReviewRevision`), prints (`seedReviewPrint`) and FCC notes (`seedFccNote`) have none: a review goes
 * when the release or item it names is deleted, a revision with its review, and a print or note with its
 * item or release (all `ON DELETE CASCADE`). `seedReview` writes no revision.
 *
 * Everything runs on the shared `getTestDb()` pool; callers must not end it.
 *
 * Usage:
 *   const {
 *     seedAuthUser, removeSeededAuthUsers,
 *     seedIntakeItem,
 *     seedLibraryRelease, removeSeededLibraryReleases,
 *     seedReview, seedReviewRevision, seedReviewPrint, seedFccNote,
 *     seedFormSubmission, removeSeededFormSubmissions,
 *     managerAccessToken,
 *   } = require('../utils/intake_seed');
 */

const { getTestDb } = require('./db');
const getAccessToken = require('./better_auth');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const FORMAT_ID = 1; // exists in the integration fixture
// `code_letters` of every artist `seedLibraryRelease` creates. Not 'ZZ': album-reviews, digital-archive-playback
// and intake-transitions sweep their own artists on `code_letters = 'ZZ'` and would delete a seeded one still in use.
const SEEDED_CODE_LETTERS = 'ZQ';

const seededUserIds = [];
const seededLibraryIds = [];
const seededArtistIds = [];
const seededSubmissionIds = [];

/**
 * Insert an `auth_user` row and remember its id for `removeSeededAuthUsers`.
 * `overrides` may set any of `id`, `name`, `email`, `real_name`; the id and email default to unique values.
 * Returns the inserted row.
 */
async function seedAuthUser(overrides = {}) {
  const sql = getTestDb();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id: `intake-test-${tag}`,
    name: 'Intake Test',
    email: `intake-${tag}@test.wxyc.org`,
    email_verified: true,
    ...overrides,
  };
  const [user] = await sql`INSERT INTO auth_user ${sql(row)} RETURNING *`;
  seededUserIds.push(user.id);
  return user;
}

/** Delete every user seeded by `seedAuthUser` (ids already deleted by a test are fine). */
async function removeSeededAuthUsers() {
  if (seededUserIds.length === 0) return;
  const sql = getTestDb();
  await sql`DELETE FROM auth_user WHERE id = ANY(${seededUserIds})`;
  seededUserIds.length = 0;
}

/**
 * Insert an `intake_items` row. `overrides` is a column -> value map layered over the NOT NULL
 * defaults (a WXYC-representative artist/album and fixture format). Returns the inserted row.
 * Cleanup is the caller's, since specs scope their rows differently.
 */
async function seedIntakeItem(overrides = {}) {
  const sql = getTestDb();
  const row = {
    artist_name: 'Jessica Pratt',
    album_title: 'On Your Own Love Again',
    format_id: FORMAT_ID,
    ...overrides,
  };
  const [item] = await sql`INSERT INTO ${sql(SCHEMA)}.intake_items ${sql(row)} RETURNING *`;
  return item;
}

/**
 * Insert one `artists` row and one `library` row and return the library row. Defaults: Juana Molina,
 * *DOGA*, the fixture format and the first genre by id. `overrides` may set any `library` column; when it
 * sets `artist_id` that artist is used and no `artists` row is inserted, so two releases can share one
 * artist. The denormalized `library.artist_name` then defaults to that artist's own name, read from
 * `artists`, unless `overrides` sets `artist_name`. `code_number` is random per call (a `smallint`; the
 * schema does not enforce uniqueness, the randomness just keeps seeded rows clear of specs that look at
 * call numbers). Ids are remembered for `removeSeededLibraryReleases`.
 */
async function seedLibraryRelease(overrides = {}) {
  const sql = getTestDb();
  let artistId = overrides.artist_id;
  let artistName = overrides.artist_name;
  if (artistId === undefined) {
    artistName ??= 'Juana Molina';
    const [artist] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${artistName}, ${artistName}, ${SEEDED_CODE_LETTERS}) RETURNING id`;
    artistId = artist.id;
    seededArtistIds.push(artistId);
  } else if (artistName === undefined) {
    const [artist] = await sql`SELECT artist_name FROM ${sql(SCHEMA)}.artists WHERE id = ${artistId}`;
    if (!artist) throw new Error(`seedLibraryRelease: no artists row with id ${artistId}`);
    artistName = artist.artist_name;
  }
  const [genre] = await sql`SELECT id FROM ${sql(SCHEMA)}.genres ORDER BY id LIMIT 1`;
  const row = {
    genre_id: genre.id,
    format_id: FORMAT_ID,
    album_title: 'DOGA',
    code_number: 1 + Math.floor(Math.random() * 32000),
    artist_name: artistName,
    ...overrides,
    artist_id: artistId,
  };
  const [release] = await sql`INSERT INTO ${sql(SCHEMA)}.library ${sql(row)} RETURNING *`;
  seededLibraryIds.push(release.id);
  return release;
}

/**
 * Delete the `library` rows `seedLibraryRelease` created, by id, then the `artists` rows it created.
 * Deleting a release also removes the reviews and intake items stamped with it: `reviews.album_id` and
 * `intake_items.album_id` are both `ON DELETE CASCADE`.
 *
 * Only the seeded `library` rows go first. A `library` row a spec created some other way under a seeded
 * artist (an API call that files a new release, say) must be deleted by the spec before this runs: the
 * artists delete would otherwise fail on the `library.artist_id` foreign key (NO ACTION) and fail the
 * `afterAll` hook, leaking the artist into the rest of the `--runInBand` run.
 */
async function removeSeededLibraryReleases() {
  const sql = getTestDb();
  if (seededLibraryIds.length > 0) {
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${seededLibraryIds})`;
    seededLibraryIds.length = 0;
  }
  if (seededArtistIds.length > 0) {
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ANY(${seededArtistIds})`;
    seededArtistIds.length = 0;
  }
}

/**
 * Insert a `reviews` row and return it. `overrides` may set any column (`album_id`, `intake_item_id`,
 * `status: 'draft'`, `author_user_id`, ...); it must name `album_id` or `intake_item_id` (CHECK
 * `reviews_target_ck`). A `submitted` review without `submitted_at` gets now. No remove function: a review
 * goes when its release or its item is deleted.
 */
async function seedReview(overrides = {}) {
  if (overrides.album_id == null && overrides.intake_item_id == null) {
    throw new Error('seedReview needs album_id or intake_item_id in overrides (reviews_target_ck)');
  }
  const sql = getTestDb();
  const row = { review: 'A short review.', author: 'Test Reviewer', ...overrides };
  if ((row.status ?? 'submitted') === 'submitted' && row.submitted_at === undefined) {
    row.submitted_at = new Date().toISOString();
  }
  const [review] = await sql`INSERT INTO ${sql(SCHEMA)}.reviews ${sql(row)} RETURNING *`;
  return review;
}

/**
 * Insert a `review_revisions` row and return it. `overrides` must set `review_id`. `revision` defaults to the
 * review's highest revision plus one (1 for the first). `seedReview` writes no revision: a test that needs a
 * submitted review's revision 1 (which the submit route writes in production) seeds it here. No remove
 * function: revisions go with their review (`ON DELETE CASCADE`).
 */
async function seedReviewRevision(overrides = {}) {
  if (overrides.review_id == null) {
    throw new Error('seedReviewRevision needs review_id in overrides');
  }
  const sql = getTestDb();
  const row = { review: 'A short review.', ...overrides };
  if (row.revision === undefined) {
    const [{ next }] = await sql`
      SELECT COALESCE(MAX(revision), 0) + 1 AS next
      FROM ${sql(SCHEMA)}.review_revisions WHERE review_id = ${row.review_id}`;
    row.revision = next;
  }
  const [revision] = await sql`INSERT INTO ${sql(SCHEMA)}.review_revisions ${sql(row)} RETURNING *`;
  return revision;
}

/**
 * Insert a `review_prints` row and return it. `overrides` must name `intake_item_id` or `album_id` (CHECK
 * `review_prints_target_ck`). No remove function: a print goes when its item or release is deleted.
 */
async function seedReviewPrint(overrides = {}) {
  if (overrides.intake_item_id == null && overrides.album_id == null) {
    throw new Error('seedReviewPrint needs intake_item_id or album_id in overrides (review_prints_target_ck)');
  }
  const sql = getTestDb();
  const [print] = await sql`INSERT INTO ${sql(SCHEMA)}.review_prints ${sql(overrides)} RETURNING *`;
  return print;
}

/**
 * Insert an `fcc_notes` row and return it, with placeholder `track` and `note` text and the column default
 * for `status`. `overrides` must name `album_id` or `intake_item_id` (CHECK `fcc_notes_target_ck`). No remove
 * function: a note goes when its release or item is deleted.
 */
async function seedFccNote(overrides = {}) {
  if (overrides.album_id == null && overrides.intake_item_id == null) {
    throw new Error('seedFccNote needs album_id or intake_item_id in overrides (fcc_notes_target_ck)');
  }
  const sql = getTestDb();
  const row = { track: 'la paradoja', note: 'A placeholder note.', ...overrides };
  const [note] = await sql`INSERT INTO ${sql(SCHEMA)}.fcc_notes ${sql(row)} RETURNING *`;
  return note;
}

/**
 * Insert an `album_review_submissions` row (the Google Form archive) and remember its id for
 * `removeSeededFormSubmissions`. `overrides` may set any column. Returns the inserted row.
 */
async function seedFormSubmission(overrides = {}) {
  const sql = getTestDb();
  const row = {
    artist_name: 'Jessica Pratt',
    album_title: 'On Your Own Love Again',
    review: 'A form review.',
    ...overrides,
  };
  const [submission] = await sql`INSERT INTO ${sql(SCHEMA)}.album_review_submissions ${sql(row)} RETURNING *`;
  seededSubmissionIds.push(submission.id);
  return submission;
}

/** Delete every form submission seeded by `seedFormSubmission`, by id. */
async function removeSeededFormSubmissions() {
  if (seededSubmissionIds.length === 0) return;
  const sql = getTestDb();
  await sql`DELETE FROM ${sql(SCHEMA)}.album_review_submissions WHERE id = ANY(${seededSubmissionIds})`;
  seededSubmissionIds.length = 0;
}

/**
 * Access token for the seeded `test_station_manager`, whose role claim holds `reviews: manage`.
 * The shared `global.access_token` is a plain DJ in CI and does not.
 */
function managerAccessToken() {
  return getAccessToken('test_station_manager', 'testpassword123');
}

module.exports = {
  seedAuthUser,
  removeSeededAuthUsers,
  seedIntakeItem,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedReviewRevision,
  seedReviewPrint,
  seedFccNote,
  seedFormSubmission,
  removeSeededFormSubmissions,
  managerAccessToken,
};
