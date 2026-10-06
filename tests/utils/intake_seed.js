/**
 * Shared seeders for the intake and review integration specs (`tests/integration/intake-*.spec.js`,
 * `reviews*.spec.js` and `library-restore-*.spec.js`, and the slices that follow). `reviews.spec.js` and
 * `intake-items.spec.js` take their releases, reviews and form-archive reviews from here, and
 * `intake-seed.spec.js` covers the seeders themselves. A spec that needs a user, an intake item, a
 * library release, a review, a review revision, a print, an FCC note or a form-archive review seeds it
 * here and does not hand-write the INSERT.
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
 * item or release (all `ON DELETE CASCADE`).
 *
 * `seedReview` writes no revision, so a seeded submitted review has no history. `PATCH /reviews/{id}` writes a
 * `review_revisions` row on every content edit of a submitted review through `writeReviewRevision`
 * (`apps/backend/services/reviews.service.ts`, WXYC/Backend-Service#2859); the first such edit of a review with
 * no history first backfills revision 1 (the pre-edit content, `edited_by` = `reviews.author`, `edited_by_user_id`
 * = `author_user_id`, `edited_at` = `submitted_at`, or `last_modified` when that is NULL), then writes revision 2.
 * The submit route (WXYC/Backend-Service#2854, still open) will write revision 1 at submit time the same way. A
 * test that needs revisions without going through a route seeds them with `seedReviewRevision`. A seeded revision
 * 1 switches that first-edit backfill off (the route backfills only a review whose highest revision is 0), so a
 * test of the backfill must not seed one. A seeded revision carries placeholder `review` text, NULL `edited_by`
 * and `edited_by_user_id`, and `edited_at` = now(); a test whose seeded revision must look like the route's
 * passes the review's five content fields (`review`, `artist_blurb`, `buzzwords`, `recommended_tracks`, `fcc`),
 * `edited_by`, `edited_by_user_id` and `edited_at`.
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
// `code_letters` of every artist `seedLibraryRelease` creates. The seeder removes its artists by id, so the value
// needs no meaning; what it must not do is appear in another spec's cleanup sweep or bucket assertion. 'ZZ' is
// out: album-reviews deletes artists named Juana Molina, this seeder's default, with `code_letters = 'ZZ'`, and
// digital-archive-playback and intake-transitions sweep on it under their own names. 'ZQ' is out: it is the
// BS#2489 bucket whose exact membership and order library.spec.js asserts. 'SEED' is four characters, the
// column's full width, reads as what it is, and no other file under tests/ names it or imports this constant;
// `intake-seed.spec.js` walks tests/ for either to keep it that way (a sweep on the imported name would delete
// exactly what a sweep on the literal would). The export exists for that pin alone: a spec that wants seeded
// rows gone calls `removeSeededLibraryReleases`, and does not sweep on these letters.
const SEEDED_CODE_LETTERS = 'SEED';

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
 * Deleting a release also removes the reviews, intake items, prints and FCC notes stamped with it
 * (`reviews.album_id`, `intake_items.album_id`, `review_prints.album_id` and `fcc_notes.album_id` are all
 * `ON DELETE CASCADE`), and each review's revisions with the review.
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
 * Insert a `review_revisions` row and return it. `overrides` must set `review_id`. `revision`, when omitted or
 * `null`, defaults to the review's own highest revision plus one (1 for the first); the column is NOT NULL, so
 * `null` cannot mean anything else. `seedReview` writes no revision; `PATCH /reviews/{id}` writes one on every
 * content edit of a submitted review through `writeReviewRevision` (`apps/backend/services/reviews.service.ts`),
 * backfilling revision 1 first when the review has no history, and WXYC/Backend-Service#2854's submit will write
 * revision 1 at submit time. Seed revisions here only when the test does not go through a route, and never in a
 * test of that backfill: a seeded revision 1 switches it off. The defaults are placeholder `review` text, NULL
 * `edited_by` and `edited_by_user_id`, and `edited_at` = now(), not the review's own, so a test that needs the
 * revision to match its review passes the review's five content fields, `edited_by`, `edited_by_user_id` and
 * `edited_at` in `overrides`. No remove function: revisions go with their review (`ON DELETE CASCADE`).
 */
async function seedReviewRevision(overrides = {}) {
  if (overrides.review_id == null) {
    throw new Error('seedReviewRevision needs review_id in overrides');
  }
  const sql = getTestDb();
  const row = { review: 'A short review.', ...overrides };
  if (row.revision == null) {
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
  SEEDED_CODE_LETTERS,
};
