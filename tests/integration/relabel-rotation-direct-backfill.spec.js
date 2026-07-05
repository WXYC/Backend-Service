/**
 * Re-run safety pin for scripts/relabel-rotation-direct-backfill.sql (BS#1521).
 *
 * The relabel is a one-shot that flips the 2026-05-29 bypass-LML rescue's rows
 * from the placeholder `lml_offline_backfill` to `discogs_direct_backfill`. Its
 * former header FALSELY claimed "re-running is a no-op": the UPDATE was
 * unconditional, so a re-run AFTER the (now-gated) LML backfill job writes fresh
 * `lml_offline_backfill` rows would REPAINT those rows to `discogs_direct_backfill`
 * — corrupting the exact provenance signal the #1517 audit and #1522 recurring
 * check key on.
 *
 * The fix adds a pure-SQL `AND NOT EXISTS (… discogs_direct_backfill …)` guard to
 * the UPDATE. These tests execute the REAL statement extracted from the script
 * file (schema-substituted into a throwaway schema so there is zero drift between
 * the artifact and what is tested, and zero blast radius on wxyc_schema).
 *
 * The throwaway table types `discogs_release_id_source` as `text` rather than the
 * production enum: the guard is pure string comparison/assignment, so the enum
 * constraint is orthogonal to the behavior under test.
 */

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

const TEST_SCHEMA = 'relabel_guard_test';
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'relabel-rotation-direct-backfill.sql');

/**
 * Pull the real, non-commented UPDATE statement out of the operator script and
 * retarget it at the throwaway schema. Comment (`--`) and psql meta (`\`) lines
 * are dropped first so the reversible-UPDATE example in the header comment can't
 * be mistaken for the live statement.
 */
function extractGuardedUpdate(scriptText, targetSchema) {
  const sqlOnly = scriptText
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('--') && !t.startsWith('\\');
    })
    .join('\n');
  const match = sqlOnly.match(/UPDATE[\s\S]*?;/i);
  if (!match) {
    throw new Error('could not locate the UPDATE statement in relabel-rotation-direct-backfill.sql');
  }
  return match[0].replace(/wxyc_schema\./g, `${targetSchema}.`);
}

describe('relabel-rotation-direct-backfill re-run safety (BS#1521)', () => {
  let sql;
  let guardedUpdate;

  beforeAll(async () => {
    sql = getTestDb();
    const scriptText = fs.readFileSync(SCRIPT_PATH, 'utf8');
    guardedUpdate = extractGuardedUpdate(scriptText, TEST_SCHEMA);

    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.rotation (
        id serial PRIMARY KEY,
        discogs_release_id_source text NOT NULL,
        kill_date date
      )
    `);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE ${TEST_SCHEMA}.rotation RESTART IDENTITY`);
  });

  async function sourceCounts() {
    const rows = await sql`
      SELECT discogs_release_id_source AS src, COUNT(*)::int AS n
      FROM ${sql(TEST_SCHEMA)}.rotation
      GROUP BY 1
    `;
    return Object.fromEntries(rows.map((r) => [r.src, r.n]));
  }

  test('re-run does NOT repaint fresh lml_offline_backfill rows once a relabel has happened', async () => {
    // Arrange: the post-first-run state (one relabeled rescue row) plus a fresh
    // `lml_offline_backfill` row the gated LML backfill job legitimately wrote later.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.rotation (discogs_release_id_source, kill_date)
      VALUES ('discogs_direct_backfill', NULL), ('lml_offline_backfill', NULL)
    `;

    // Act: an accidental re-run of the relabel.
    await sql.unsafe(guardedUpdate);

    // Assert: the LML job's row is untouched; provenance is preserved.
    const counts = await sourceCounts();
    expect(counts['lml_offline_backfill']).toBe(1);
    expect(counts['discogs_direct_backfill']).toBe(1);
  });

  test('a pristine first run still repaints every lml_offline_backfill row', async () => {
    // Arrange: the 2026-05-29 rescue's state — only the placeholder source, and
    // no discogs_direct_backfill row exists yet.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.rotation (discogs_release_id_source, kill_date)
      VALUES ('lml_offline_backfill', NULL), ('lml_offline_backfill', NULL)
    `;

    await sql.unsafe(guardedUpdate);

    // Assert: the guard does not over-block; the legitimate first relabel lands.
    const counts = await sourceCounts();
    expect(counts['lml_offline_backfill']).toBeUndefined();
    expect(counts['discogs_direct_backfill']).toBe(2);
  });

  test('a killed relabeled row still blocks a re-run (guard has no kill_date filter)', async () => {
    // Arrange: every rescue row has since been killed (kill_date set), and the
    // LML job wrote a fresh lml_offline_backfill row. If the guard filtered on
    // kill_date IS NULL it would see zero live discogs_direct_backfill rows and
    // silently re-arm — repainting the LML row. It must not.
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.rotation (discogs_release_id_source, kill_date)
      VALUES ('discogs_direct_backfill', '2026-01-01'), ('lml_offline_backfill', NULL)
    `;

    await sql.unsafe(guardedUpdate);

    const counts = await sourceCounts();
    expect(counts['lml_offline_backfill']).toBe(1);
    expect(counts['discogs_direct_backfill']).toBe(1);
  });

  test('re-running immediately after a completed relabel affects zero rows', async () => {
    // Arrange: reach the completed state via the script itself (first run).
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.rotation (discogs_release_id_source, kill_date)
      VALUES ('lml_offline_backfill', NULL), ('lml_offline_backfill', NULL)
    `;
    await sql.unsafe(guardedUpdate);

    // Act: the genuine-no-op proof — a second, identical run.
    const rerun = await sql.unsafe(guardedUpdate);

    // Assert: zero rows touched, and the distribution is unchanged.
    expect(rerun.count).toBe(0);
    const counts = await sourceCounts();
    expect(counts['discogs_direct_backfill']).toBe(2);
    expect(counts['lml_offline_backfill']).toBeUndefined();
  });
});
