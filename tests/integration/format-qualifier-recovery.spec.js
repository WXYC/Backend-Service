const { readFileSync } = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

/**
 * Exercises scripts/audit/bs_format_qualifier_recovery.sql (BS#2116) against
 * a live Postgres. The script is a hand-run operator script, not a Drizzle
 * migration (docs/migrations.md "Migrations are DDL-only") -- see the
 * script's own header for why it needed no DDL. This spec seeds three
 * `library` rows keyed on real tubafrenzy legacy_release_ids and asserts the
 * script moves exactly the ones it should:
 *
 *   - LEGACY_ID_BROKEN (61): tubafrenzy says `vinyl - 12"`. Forced to the
 *     coarse pre-bug state (format `vinyl`, disc_quantity 1) before the
 *     script runs. Expect it corrected to (`vinyl 12"`, 1).
 *   - LEGACY_ID_ALREADY_CORRECT (69): also `vinyl - 12"` in tubafrenzy.
 *     Forced to the already-correct state (`vinyl 12"`, 1) before the
 *     script runs. Expect no write at all (xmin unchanged) -- the
 *     `IS DISTINCT FROM` no-op path.
 *   - LEGACY_ID_PLAIN_VINYL (2): genuinely plain `vinyl` in tubafrenzy (not
 *     in tf_format_qualified.tsv at all -- confirmed absent by grep against
 *     the source tsv). Expect it completely untouched: not in the script's
 *     staged candidate set, so the join can't match it regardless of its
 *     current format.
 *
 * All three ids are real tubafrenzy LIBRARY_RELEASE.IDs already present in
 * the dev Postgres's prod-clone seed (dev_env/seed-clone.sql) -- picked
 * (not invented) so the script's embedded 5,261-row staging table actually
 * contains the two that should move. Each row's pre-test (format_id,
 * disc_quantity) is captured and restored in `afterAll` so the spec doesn't
 * leave the shared dev database mutated between runs.
 */

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'audit', 'bs_format_qualifier_recovery.sql');

const LEGACY_ID_BROKEN = 61; // tubafrenzy: vinyl - 12"
const LEGACY_ID_ALREADY_CORRECT = 69; // tubafrenzy: vinyl - 12"
const LEGACY_ID_PLAIN_VINYL = 2; // tubafrenzy: plain vinyl, not in tf_format_qualified.tsv

async function getFormatIdByName(sql, name) {
  const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.format WHERE format_name = ${name}`;
  if (rows.length === 0) {
    throw new Error(`Seed format "${name}" not found in ${SCHEMA}.format -- fixture drift?`);
  }
  return rows[0].id;
}

async function getLibraryState(sql, legacyReleaseId) {
  const rows = await sql`
    SELECT id, format_id, disc_quantity, xmin::text AS xmin
    FROM ${sql(SCHEMA)}.library
    WHERE legacy_release_id = ${legacyReleaseId}
  `;
  if (rows.length === 0) {
    throw new Error(`legacy_release_id ${legacyReleaseId} not found -- expected it seeded via dev_env/seed-clone.sql`);
  }
  return rows[0];
}

async function setLibraryFormat(sql, legacyReleaseId, formatId, discQuantity) {
  await sql`
    UPDATE ${sql(SCHEMA)}.library
    SET format_id = ${formatId}, disc_quantity = ${discQuantity}
    WHERE legacy_release_id = ${legacyReleaseId}
  `;
}

describe('BS#2116 format-qualifier recovery script', () => {
  let sql;
  let vinylId;
  let vinyl12Id;
  let originalBroken;
  let originalAlreadyCorrect;
  let originalPlainVinyl;

  beforeAll(async () => {
    sql = getTestDb();
    vinylId = await getFormatIdByName(sql, 'vinyl');
    vinyl12Id = await getFormatIdByName(sql, 'vinyl 12"');

    originalBroken = await getLibraryState(sql, LEGACY_ID_BROKEN);
    originalAlreadyCorrect = await getLibraryState(sql, LEGACY_ID_ALREADY_CORRECT);
    originalPlainVinyl = await getLibraryState(sql, LEGACY_ID_PLAIN_VINYL);

    // Arrange: force the "broken" row back to the coarse pre-fix state
    // regardless of whatever state a prior run of the recovery script left
    // it in.
    await setLibraryFormat(sql, LEGACY_ID_BROKEN, vinylId, 1);
    // Arrange: force the "already correct" row to the target state.
    await setLibraryFormat(sql, LEGACY_ID_ALREADY_CORRECT, vinyl12Id, 1);
  });

  afterAll(async () => {
    // Restore every row's original state. Pool is shared with the rest of
    // the integration suite; do NOT close it.
    await setLibraryFormat(sql, LEGACY_ID_BROKEN, originalBroken.format_id, originalBroken.disc_quantity);
    await setLibraryFormat(
      sql,
      LEGACY_ID_ALREADY_CORRECT,
      originalAlreadyCorrect.format_id,
      originalAlreadyCorrect.disc_quantity
    );
    await setLibraryFormat(sql, LEGACY_ID_PLAIN_VINYL, originalPlainVinyl.format_id, originalPlainVinyl.disc_quantity);
  });

  test('corrects a coarse row, no-ops an already-correct row, and leaves a genuinely plain-vinyl row untouched', async () => {
    const beforeAlreadyCorrect = await getLibraryState(sql, LEGACY_ID_ALREADY_CORRECT);
    const beforePlainVinyl = await getLibraryState(sql, LEGACY_ID_PLAIN_VINYL);

    // The script issues its own BEGIN/COMMIT (and ANALYZE outside them), so
    // it must run on one dedicated connection rather than the shared pool --
    // postgres.js refuses raw transaction-control statements over a pooled
    // connection (UNSAFE_TRANSACTION) since another query could interleave.
    // sql.reserve() is the documented escape hatch (see also `sql.begin` /
    // `max: 1`, neither of which fits here: `sql.begin` would nest its own
    // wrapper transaction around the script's internal COMMIT).
    const scriptSql = readFileSync(SCRIPT_PATH, 'utf-8');
    const reserved = await sql.reserve();
    try {
      await reserved.unsafe(scriptSql);
    } finally {
      reserved.release();
    }

    const afterBroken = await getLibraryState(sql, LEGACY_ID_BROKEN);
    expect(afterBroken.format_id).toBe(vinyl12Id);
    expect(afterBroken.disc_quantity).toBe(1);

    const afterAlreadyCorrect = await getLibraryState(sql, LEGACY_ID_ALREADY_CORRECT);
    expect(afterAlreadyCorrect.format_id).toBe(vinyl12Id);
    expect(afterAlreadyCorrect.disc_quantity).toBe(1);
    // No write should have happened at all -- xmin unchanged.
    expect(afterAlreadyCorrect.xmin).toBe(beforeAlreadyCorrect.xmin);

    const afterPlainVinyl = await getLibraryState(sql, LEGACY_ID_PLAIN_VINYL);
    expect(afterPlainVinyl.format_id).toBe(beforePlainVinyl.format_id);
    expect(afterPlainVinyl.disc_quantity).toBe(beforePlainVinyl.disc_quantity);
    expect(afterPlainVinyl.xmin).toBe(beforePlainVinyl.xmin);
  });
});
