/**
 * Re-run + correctness pin for scripts/audit/bs_replacement_char_phase4.sql (BS#2114).
 *
 * The Phase 4 script repairs 11 rows of residual U+FFFD mojibake left behind by the
 * #863 recovery: the `µ-Ziq [mu-Ziq]` artist name (10 catalog ids, denormalized from
 * one `artists` row per migration 0060's cascade) and the `La Bête` album title (1
 * catalog id). These tests execute the REAL UPDATE statements extracted from the
 * script file (schema-substituted into a throwaway schema, same technique as
 * relabel-rotation-direct-backfill.spec.js) so there is zero drift between the
 * artifact under test and what prod actually runs.
 *
 * What's pinned:
 *  - the artist fix touches every one of the 10 named catalog ids, and only those;
 *  - the title fix touches catalog id 50340, and only that id;
 *  - a row that merely shares bytes with the corrupt strings (same 0xEA byte as the
 *    corrupt "La B�te", or the same "-Ziq [mu-Ziq]" suffix under a different artist)
 *    is left untouched -- the match is on the full corrupt string, not a substring;
 *  - a row holding the EXACT corrupt string at a `legacy_release_id` the ticket does
 *    NOT name is left untouched. This is the pin that makes "and only those" mean
 *    something: with only near-miss decoys, the exact-string predicate alone spares
 *    them and the `legacy_release_id IN (...)` scoping is never exercised -- dropping
 *    that scoping entirely (widening either UPDATE into a table-wide rewrite) still
 *    passed every assertion. An exact-string, out-of-scope row is the only decoy that
 *    fails when the scoping is removed, so it is what actually bounds the blast
 *    radius of the operator script against a future well-meaning edit;
 *  - a second run is a genuine no-op (0 rows affected) once the first has landed,
 *    proving the self-correcting / idempotent design the script's header claims;
 *  - the `artists` UPDATE and the `library` safety-net UPDATE don't double-count or
 *    conflict with each other -- both are exercised because the throwaway schema
 *    does not recreate migration 0060's cascade trigger, so this test is the only
 *    place the `library` safety-net UPDATE's own correctness is actually verified
 *    (in prod the trigger would normally do that half of the work first).
 *
 * The throwaway tables use plain `text` columns rather than the production
 * `varchar(128)` -- irrelevant to the string-equality UPDATE logic under test.
 */

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

const TEST_SCHEMA = 'bs2114_mojibake_test';
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'audit', 'bs_replacement_char_phase4.sql');

const CORRUPT_ARTIST = '�-Ziq [mu-Ziq]';
const CORRECT_ARTIST = 'µ-Ziq [mu-Ziq]'; // µ-Ziq [mu-Ziq]
const CORRUPT_TITLE = 'La B�te';
const CORRECT_TITLE = 'La Bête'; // La Bête

const TARGET_ARTIST_IDS = [1977, 1978, 1979, 1980, 1981, 1982, 1983, 37529, 63110, 69776];
const TARGET_TITLE_ID = 50340;

/**
 * Pull the real UPDATE statements out of the operator script and retarget them at
 * the throwaway schema. Same hazards guarded against as
 * relabel-rotation-direct-backfill.spec.js's extractor:
 *   - psql meta (`\`) lines are dropped and both full-line and trailing inline `--`
 *     comments are stripped, so a `;` inside a comment (the header prose describes
 *     "the first UPDATE below" etc.) can't be mistaken for a statement boundary;
 *   - requires EXACTLY THREE UPDATEs. If a future edit adds, removes, or reorders
 *     one, this throws instead of silently validating a different statement set
 *     than the one prod runs.
 */
function extractUpdates(scriptText, targetSchema) {
  const sqlOnly = scriptText
    .split('\n')
    .filter((line) => !line.trim().startsWith('\\'))
    .map((line) => {
      const comment = line.indexOf('--');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join('\n');
  const matches = sqlOnly.match(/UPDATE[\s\S]*?;/gi) ?? [];
  if (matches.length !== 3) {
    throw new Error(`expected exactly 3 UPDATEs in bs_replacement_char_phase4.sql, found ${matches.length}`);
  }
  return matches.map((m) => m.replace(/wxyc_schema\./g, `${targetSchema}.`));
}

describe('bs_replacement_char_phase4 mojibake repair (BS#2114)', () => {
  let sql;
  let updates;

  beforeAll(async () => {
    sql = getTestDb();
    const scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8');
    updates = extractUpdates(scriptText, TEST_SCHEMA);

    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.artists (
        id serial PRIMARY KEY,
        artist_name text NOT NULL
      )
    `);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.library (
        id serial PRIMARY KEY,
        legacy_release_id integer NOT NULL,
        artist_name text,
        album_title text
      )
    `);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE ${TEST_SCHEMA}.artists, ${TEST_SCHEMA}.library RESTART IDENTITY`);
  });

  async function runScript() {
    let totalAffected = 0;
    for (const stmt of updates) {
      const result = await sql.unsafe(stmt);
      totalAffected += result.count;
    }
    return totalAffected;
  }

  async function seedTargetRows() {
    // The source-of-truth artists row, still corrupt.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.artists (artist_name) VALUES (${CORRUPT_ARTIST})
    `;
    // The 10 named catalog ids, denormalized copies also still corrupt -- no cascade
    // trigger exists in this throwaway schema, so these rows are independent of the
    // artists row above until the script's second UPDATE fixes them directly.
    for (const id of TARGET_ARTIST_IDS) {
      await sql`
        INSERT INTO ${sql(TEST_SCHEMA)}.library (legacy_release_id, artist_name, album_title)
        VALUES (${id}, ${CORRUPT_ARTIST}, 'some other album')
      `;
    }
    // The one title-corrupt catalog id.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.library (legacy_release_id, artist_name, album_title)
      VALUES (${TARGET_TITLE_ID}, 'The Cripple Lillies', ${CORRUPT_TITLE})
    `;
  }

  async function libraryRow(legacyReleaseId) {
    const rows = await sql`
      SELECT artist_name, album_title FROM ${sql(TEST_SCHEMA)}.library WHERE legacy_release_id = ${legacyReleaseId}
    `;
    return rows[0];
  }

  test('fixes the artists source-of-truth row', async () => {
    await seedTargetRows();

    await runScript();

    const rows = await sql`SELECT artist_name FROM ${sql(TEST_SCHEMA)}.artists`;
    expect(rows).toHaveLength(1);
    expect(rows[0].artist_name).toBe(CORRECT_ARTIST);
  });

  test('fixes library.artist_name for every one of the 10 named catalog ids, and only those', async () => {
    await seedTargetRows();
    // A neighbor row sharing the "-Ziq [mu-Ziq]" suffix under a DIFFERENT corrupt
    // prefix, at an id NOT in the target list -- must not be touched by a loose match.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.library (legacy_release_id, artist_name, album_title)
      VALUES (999999, ${'�ther-Ziq [mu-Ziq]'}, 'unrelated')
    `;
    // The scoping decoy: the EXACT corrupt string, at an id BS#2114 does not name.
    // Only `legacy_release_id IN (...)` keeps the UPDATE off this row, so this is the
    // assertion that fails if that scoping is ever widened or dropped.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.library (legacy_release_id, artist_name, album_title)
      VALUES (900001, ${CORRUPT_ARTIST}, 'out of ticket scope')
    `;

    await runScript();

    for (const id of TARGET_ARTIST_IDS) {
      const row = await libraryRow(id);
      expect(row.artist_name).toBe(CORRECT_ARTIST);
    }
    const untouched = await libraryRow(999999);
    expect(untouched.artist_name).toBe('�ther-Ziq [mu-Ziq]');
    const outOfScope = await libraryRow(900001);
    expect(outOfScope.artist_name).toBe(CORRUPT_ARTIST);
  });

  test('fixes library.album_title for catalog id 50340, and only that id', async () => {
    await seedTargetRows();
    // A neighbor row with the same 0xEA ("ê") byte in a clean, already-correct
    // title -- proves the match is on the full corrupt string, not a fuzzy/byte
    // match that could clobber an unrelated accented title.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.library (legacy_release_id, artist_name, album_title)
      VALUES (888888, 'Some Artist', ${'La Forêt'})
    `;
    // The scoping decoy, as above: the EXACT corrupt title at an unnamed id.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.library (legacy_release_id, artist_name, album_title)
      VALUES (900002, 'Some Other Artist', ${CORRUPT_TITLE})
    `;

    await runScript();

    const fixed = await libraryRow(TARGET_TITLE_ID);
    expect(fixed.album_title).toBe(CORRECT_TITLE);
    const untouched = await libraryRow(888888);
    expect(untouched.album_title).toBe('La Forêt');
    const outOfScope = await libraryRow(900002);
    expect(outOfScope.album_title).toBe(CORRUPT_TITLE);
  });

  test('the U+FFFD predicate returns 0 across artist_name/album_title after the run', async () => {
    await seedTargetRows();

    await runScript();

    const [{ remaining }] = await sql`
      SELECT COUNT(*)::int AS remaining
      FROM ${sql(TEST_SCHEMA)}.library
      WHERE artist_name LIKE '%' || chr(65533) || '%' OR album_title LIKE '%' || chr(65533) || '%'
    `;
    expect(remaining).toBe(0);
    const [{ artistsRemaining }] = await sql`
      SELECT COUNT(*)::int AS "artistsRemaining"
      FROM ${sql(TEST_SCHEMA)}.artists
      WHERE artist_name LIKE '%' || chr(65533) || '%'
    `;
    expect(artistsRemaining).toBe(0);
  });

  test('a second run is a genuine no-op once the first has landed', async () => {
    await seedTargetRows();
    const firstRunAffected = await runScript();
    expect(firstRunAffected).toBeGreaterThan(0);

    const secondRunAffected = await runScript();

    expect(secondRunAffected).toBe(0);
    // Values are still correct, not reverted or double-mangled.
    const rows = await sql`SELECT artist_name FROM ${sql(TEST_SCHEMA)}.artists`;
    expect(rows[0].artist_name).toBe(CORRECT_ARTIST);
    const titleRow = await libraryRow(TARGET_TITLE_ID);
    expect(titleRow.album_title).toBe(CORRECT_TITLE);
  });

  test('is a no-op against rows that were never corrupt in the first place', async () => {
    // No seed at all -- simulates the state after tubafrenzy turndown, or a clean
    // dev database. The script must not error and must not manufacture rows.
    const affected = await runScript();

    expect(affected).toBe(0);
    const artistCount = await sql`SELECT COUNT(*)::int AS n FROM ${sql(TEST_SCHEMA)}.artists`;
    expect(artistCount[0].n).toBe(0);
    const libraryCount = await sql`SELECT COUNT(*)::int AS n FROM ${sql(TEST_SCHEMA)}.library`;
    expect(libraryCount[0].n).toBe(0);
  });
});
