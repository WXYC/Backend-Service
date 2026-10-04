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
 * Access token for the seeded `test_station_manager`, whose role claim holds `reviews: manage`.
 * The shared `global.access_token` is a plain DJ in CI and does not.
 */
function managerAccessToken() {
  return getAccessToken('test_station_manager', 'testpassword123');
}

module.exports = { seedAuthUser, removeSeededAuthUsers, seedIntakeItem, managerAccessToken };
