const { readFileSync } = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

/**
 * Exercises scripts/audit/bs_format_qualifier_recovery.sql (BS#2116) against
 * a live Postgres. The script is a hand-run operator script, not a Drizzle
 * migration (docs/migrations.md "Migrations are DDL-only") -- see the
 * script's own header for why it needed no DDL.
 *
 * Fixture strategy: this spec seeds every row it asserts on, keyed on
 * `legacy_release_id`s chosen from the script's own embedded 5,261-row
 * candidate set that are NOT present in dev_env/seed-clone.sql, plus one
 * control id the candidate set doesn't contain at all. That matters because
 * `ci-db-init` deliberately does NOT mount seed-clone.sql (see
 * dev_env/docker-compose.yml and BS#947): CI runs against the small
 * seed_db.sql fixture, whose `library` rows all take their
 * `legacy_release_id` from `library_legacy_release_id_seq` (floor
 * 1,000,000, schema.ts:516). So a spec that leaned on clone rows would pass
 * on a dev machine and fail in CI, and any id below 1,000,000 is guaranteed
 * free in both environments.
 *
 * The six seeded rows cover every class the parity harness buckets:
 *
 *   | legacy | tubafrenzy       | seeded as       | expected after      |
 *   |--------|------------------|-----------------|---------------------|
 *   | 471    | `vinyl - 12"`    | (vinyl, 1)      | (vinyl 12", 1)      |
 *   | 674    | `vinyl - 12"`    | (vinyl 12", 1)  | untouched (no-op)   |
 *   | 36676  | `vinyl - LP`     | (vinyl, 1)      | (vinyl 12", 1)      |
 *   | 42393  | `cd x 2`         | (cd, 1)         | (cd, 2)             |
 *   | 71484  | `cd x 2`         | (cd, 2)         | untouched (no-op)   |
 *   | 90001  | not a candidate  | (vinyl, 1)      | untouched (no-op)   |
 *
 * Row 36676 pins the recorded `vinyl - LP` -> `vinyl 12"` decision (BS#2116
 * asks for an explicit decision on any qualifier with no Backend
 * representation); row 71484 pins the multi-disc class that the harness
 * counts as a mismatch but that Backend already stores correctly as
 * (`cd`, disc_quantity 2) -- the script must leave those alone. The
 * `xmin` assertions make "untouched" mean "not rewritten at all", not
 * merely "rewritten to the same value".
 *
 * A whole-table checksum over every row OUTSIDE the script's embedded
 * candidate set is captured before and after, so the blast radius is
 * asserted directly rather than inferred from the WHERE clause.
 *
 * Caveat for dev runs: against the prod-clone fixture the script also
 * repairs whatever genuinely-broken clone rows are still outstanding (5 in
 * the snapshot as committed). That is the script doing its job on a
 * scratch database; only the six fixture rows above are cleaned up here.
 */

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'audit', 'bs_format_qualifier_recovery.sql');

const FIXTURE_TITLE_PREFIX = 'BS#2116 fixture';

// legacy_release_ids present in the script's embedded candidate set but
// absent from dev_env/seed-clone.sql, so this spec owns them outright in
// both CI and dev. `tubafrenzy` is the string the script staged for that
// id; `seed` is the (format name, disc quantity) the row starts at and
// `expected` is where the script must leave it.
const CASES = [
  {
    name: 'coarse vinyl row is repaired',
    legacyReleaseId: 471,
    tubafrenzy: 'vinyl - 12"',
    seed: ['vinyl', 1],
    expected: ['vinyl 12"', 1],
    rewritten: true,
  },
  {
    name: 'already-correct vinyl row is a no-op',
    legacyReleaseId: 674,
    tubafrenzy: 'vinyl - 12"',
    seed: ['vinyl 12"', 1],
    expected: ['vinyl 12"', 1],
    rewritten: false,
  },
  {
    name: 'LP maps to vinyl 12" (recorded decision)',
    legacyReleaseId: 36676,
    tubafrenzy: 'vinyl - LP',
    seed: ['vinyl', 1],
    expected: ['vinyl 12"', 1],
    rewritten: true,
  },
  {
    name: 'multi-disc CD recovers its disc_quantity, not a new format row',
    legacyReleaseId: 42393,
    tubafrenzy: 'cd x 2',
    seed: ['cd', 1],
    expected: ['cd', 2],
    rewritten: true,
  },
  {
    name: 'multi-disc CD already stored as (cd, 2) is a no-op',
    legacyReleaseId: 71484,
    tubafrenzy: 'cd x 2',
    seed: ['cd', 2],
    expected: ['cd', 2],
    rewritten: false,
  },
  {
    // 90001 is above the script's highest staged id (72273) and below the
    // Backend-minted floor (1,000,000), so it can never join the staging
    // table no matter what its format is.
    name: 'a row outside the candidate set is untouched',
    legacyReleaseId: 90001,
    tubafrenzy: null,
    seed: ['vinyl', 1],
    expected: ['vinyl', 1],
    rewritten: false,
  },
];

/**
 * The legacy_release_ids the script embeds. Parsed from the script itself
 * so the blast-radius checksum below stays correct if the candidate set is
 * ever refreshed.
 */
function readStagedLegacyReleaseIds() {
  const ids = [];
  for (const line of readFileSync(SCRIPT_PATH, 'utf-8').split('\n')) {
    const match = /^\s*\((\d+), '[^']*'\),?;?\s*$/.exec(line);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

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
    throw new Error(`legacy_release_id ${legacyReleaseId} not found -- fixture seeding failed?`);
  }
  return rows[0];
}

/**
 * md5 of every (legacy_release_id, format_id, disc_quantity) triple for
 * rows the script's staging table cannot reach. Any change here means the
 * UPDATE escaped its candidate set.
 */
async function checksumRowsOutsideCandidateSet(sql, stagedIds) {
  const rows = await sql`
    SELECT md5(
      COALESCE(string_agg(legacy_release_id || ':' || format_id || ':' || disc_quantity, ',' ORDER BY legacy_release_id), '')
    ) AS digest
    FROM ${sql(SCHEMA)}.library
    WHERE NOT (legacy_release_id = ANY(${stagedIds}))
  `;
  return rows[0].digest;
}

describe('BS#2116 format-qualifier recovery script', () => {
  let sql;
  let stagedIds;
  const formatIds = new Map();

  beforeAll(async () => {
    // The recovery script hard-codes `wxyc_schema` (it is an operator script
    // aimed at prod, not a per-worker-schema test artifact), so seeding the
    // fixture anywhere else would silently assert against rows the script
    // never looks at.
    if (SCHEMA !== 'wxyc_schema') {
      throw new Error(
        `This spec requires WXYC_SCHEMA_NAME=wxyc_schema (got "${SCHEMA}") — the recovery script is not schema-parameterized.`
      );
    }

    sql = getTestDb();
    stagedIds = readStagedLegacyReleaseIds();

    for (const name of ['cd', 'vinyl', 'vinyl 12"']) {
      formatIds.set(name, await getFormatIdByName(sql, name));
    }

    const [anchorArtist] = await sql`SELECT id FROM ${sql(SCHEMA)}.artists ORDER BY id LIMIT 1`;
    const [anchorGenre] = await sql`SELECT id FROM ${sql(SCHEMA)}.genres ORDER BY id LIMIT 1`;
    if (!anchorArtist || !anchorGenre) {
      throw new Error('No seeded artist/genre to hang the fixture library rows off -- seed_db.sql drift?');
    }

    // Idempotent re-seed: these ids are spec-owned (absent from both
    // seed_db.sql and seed-clone.sql), so clearing them first makes a
    // re-run after an aborted one behave like a fresh run.
    for (const testCase of CASES) {
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE legacy_release_id = ${testCase.legacyReleaseId}`;
      const [formatName, discQuantity] = testCase.seed;
      await sql`
        INSERT INTO ${sql(SCHEMA)}.library
          (artist_id, genre_id, format_id, album_title, code_number, disc_quantity, legacy_release_id)
        VALUES (
          ${anchorArtist.id},
          ${anchorGenre.id},
          ${formatIds.get(formatName)},
          ${`${FIXTURE_TITLE_PREFIX} ${testCase.legacyReleaseId}`},
          1,
          ${discQuantity},
          ${testCase.legacyReleaseId}
        )
      `;
    }
  });

  afterAll(async () => {
    // Pool is shared with the rest of the integration suite; do NOT close it.
    for (const testCase of CASES) {
      await sql`
        DELETE FROM ${sql(SCHEMA)}.library
        WHERE legacy_release_id = ${testCase.legacyReleaseId}
          AND album_title LIKE ${`${FIXTURE_TITLE_PREFIX}%`}
      `;
    }
  });

  test('repairs exactly the rows it should and touches nothing else', async () => {
    const before = new Map();
    for (const testCase of CASES) {
      before.set(testCase.legacyReleaseId, await getLibraryState(sql, testCase.legacyReleaseId));
    }
    const digestBefore = await checksumRowsOutsideCandidateSet(sql, stagedIds);

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

    for (const testCase of CASES) {
      const after = await getLibraryState(sql, testCase.legacyReleaseId);
      const [expectedFormat, expectedDiscs] = testCase.expected;
      expect({
        case: testCase.name,
        formatId: after.format_id,
        discQuantity: after.disc_quantity,
      }).toEqual({
        case: testCase.name,
        formatId: formatIds.get(expectedFormat),
        discQuantity: expectedDiscs,
      });

      // "Untouched" has to mean the row was never rewritten, not merely
      // rewritten to the same value -- otherwise a re-run would churn xids
      // and bloat the table.
      const xminBefore = before.get(testCase.legacyReleaseId).xmin;
      if (testCase.rewritten) {
        expect(after.xmin).not.toBe(xminBefore);
      } else {
        expect({ case: testCase.name, xmin: after.xmin }).toEqual({ case: testCase.name, xmin: xminBefore });
      }
    }

    // Blast radius: nothing outside the embedded candidate set moved.
    expect(await checksumRowsOutsideCandidateSet(sql, stagedIds)).toBe(digestBefore);
  });

  test('a second run is a no-op', async () => {
    const before = new Map();
    for (const testCase of CASES) {
      before.set(testCase.legacyReleaseId, await getLibraryState(sql, testCase.legacyReleaseId));
    }
    const digestBefore = await checksumRowsOutsideCandidateSet(sql, stagedIds);

    const scriptSql = readFileSync(SCRIPT_PATH, 'utf-8');
    const reserved = await sql.reserve();
    try {
      await reserved.unsafe(scriptSql);
    } finally {
      reserved.release();
    }

    for (const testCase of CASES) {
      const after = await getLibraryState(sql, testCase.legacyReleaseId);
      expect({ case: testCase.name, xmin: after.xmin }).toEqual({
        case: testCase.name,
        xmin: before.get(testCase.legacyReleaseId).xmin,
      });
    }
    expect(await checksumRowsOutsideCandidateSet(sql, stagedIds)).toBe(digestBefore);
  });
});
