/**
 * Shared seeders for the intake integration specs (`intake-items-schema`,
 * `intake-items`, `library-restore-deleted`, and the intake slices that follow).
 *
 * `auth_user` is better-auth's table and lives in the `public` schema, NOT in
 * `${WXYC_SCHEMA_NAME}` like every domain table. It is therefore written
 * unqualified here, and nowhere else should a spec hand-write
 * `INSERT INTO auth_user` (a `"wxyc_schema".auth_user` qualification fails
 * with "relation does not exist"). `intake_items` is a domain table and is
 * schema-qualified.
 *
 * Everything runs on the shared `getTestDb()` pool; callers must not end it.
 *
 * Usage:
 *   const { seedAuthUser, removeSeededAuthUsers, seedIntakeItem, managerAccessToken } = require('../utils/intake_seed');
 */

const { getTestDb } = require('./db');
const getAccessToken = require('./better_auth');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const FORMAT_ID = 1; // exists in the integration fixture

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
 * artist. `code_number` is random per call (a `smallint`; the schema does not enforce uniqueness, the
 * randomness just keeps seeded rows clear of specs that look at call numbers). Ids are remembered for
 * `removeSeededLibraryReleases`.
 */
async function seedLibraryRelease(overrides = {}) {
  const sql = getTestDb();
  const artistName = overrides.artist_name ?? 'Juana Molina';
  let artistId = overrides.artist_id;
  if (artistId === undefined) {
    const [artist] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES (${artistName}, ${artistName}, 'ZZ') RETURNING id`;
    artistId = artist.id;
    seededArtistIds.push(artistId);
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
  seedFormSubmission,
  removeSeededFormSubmissions,
  managerAccessToken,
};
