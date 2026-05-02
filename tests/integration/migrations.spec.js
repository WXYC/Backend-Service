/**
 * Migrations against the shape fixture (issue #701).
 *
 * Drizzle's migration runner is normally exercised against an empty
 * schema (CI's `npm run db:start` boots a fresh Docker volume and
 * applies every migration end-to-end). PR #696 demonstrated the gap
 * that creates: the unique partial index in 0071 passed CI cleanly
 * because the test rotation table was empty, but would have failed
 * against prod data because of 39 duplicate active groups.
 *
 * This spec closes the gap by asserting that:
 *
 *   1. Every entry in `_journal.json` has a row in
 *      `drizzle.__drizzle_migrations` (the runtime cursor didn't skip
 *      anything; mirrors the verifier in dev_env/init-db.mjs but
 *      against the per-worker schema this spec actually exercises).
 *   2. The shape fixture (tests/fixtures/shape.sql) is loaded into the
 *      per-worker `wxyc_schema` — its load-bearing edge cases are
 *      present. globalSetup loads the fixture before any spec runs
 *      (after migrations have already been applied at db:start time),
 *      so the fixture's mere existence is the structural guarantee
 *      that NONE of the existing migrations forbid the fixture's
 *      shape. Future PRs that add a constraint-bearing migration
 *      whose constraint the fixture violates will fail at
 *      globalSetup time (or directly in this spec, if the fixture
 *      load reaches the assertion phase) — long before a deploy
 *      attempts the migration against prod.
 *   3. `drizzle:migrate` is idempotent against the loaded fixture:
 *      re-running it must report no pending migrations and must not
 *      delete fixture rows.
 *
 * The unit suite covers each individual migration's structural form;
 * this spec is the cross-migration shape-validity guard. Companion
 * lines of defense:
 *   - PR-bot data-shape report (#703)
 *   - Precondition guards on constraint-adding migrations (#705)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const postgres = require('postgres');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'shared', 'database', 'src', 'migrations');
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'shape.sql');

/**
 * Tags whose hash will never appear in `drizzle.__drizzle_migrations`
 * because drizzle's "max(applied.created_at) cursor" skipped them and
 * a later replay migration carries their effects forward. Mirrors
 * `HISTORICAL_REPLACED_TAGS` in dev_env/init-db.mjs (kept in sync
 * manually; if this list drifts the verifier and the spec disagree).
 */
const HISTORICAL_REPLACED_TAGS = new Map([
  ['0054_flowsheet-search-doc-with-dj-name', '0065_replay-flowsheet-search-doc-with-dj-name'],
  ['0064_propagate-v012-mojibake', '0066_replay-v012-mojibake'],
]);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('Drizzle migrations + shape fixture (issue #701)', () => {
  let sql;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  test('every journal migration is recorded in drizzle.__drizzle_migrations (or has a known replay)', async () => {
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'));

    const expectedMigrations = journal.entries.map((entry) => {
      const sqlPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
      const sqlContent = fs.readFileSync(sqlPath, 'utf8');
      const hash = crypto.createHash('sha256').update(sqlContent).digest('hex');
      return { tag: entry.tag, idx: entry.idx, when: entry.when, hash };
    });

    const dbMigrations = await sql`
      SELECT hash FROM drizzle.__drizzle_migrations
    `;
    const appliedHashes = new Set(dbMigrations.map((m) => m.hash));

    const missing = expectedMigrations.filter((m) => !appliedHashes.has(m.hash));
    const trulyMissing = [];
    for (const m of missing) {
      if (HISTORICAL_REPLACED_TAGS.has(m.tag)) {
        const replayTag = HISTORICAL_REPLACED_TAGS.get(m.tag);
        const replay = expectedMigrations.find((e) => e.tag === replayTag);
        if (replay && appliedHashes.has(replay.hash)) {
          // Replayed by a later migration that did apply: expected absent.
          continue;
        }
      }
      trulyMissing.push(m);
    }

    expect(trulyMissing).toEqual([]);
  });

  test('shape fixture is loaded: 3 duplicate active rotation groups, NULL artist_name, mixed play_orders', async () => {
    // The fixture is loaded by tests/setup/globalSetup.js before any spec
    // runs. Asserting its load-bearing edge cases survived migrations is
    // the cross-migration shape-validity guard.
    const dupActive = await sql.unsafe(`
      SELECT album_id, rotation_bin, COUNT(*)::int AS n
        FROM "${SCHEMA}".rotation
       WHERE kill_date IS NULL
         AND album_id IS NOT NULL
         AND id BETWEEN 7000 AND 7099
       GROUP BY album_id, rotation_bin
      HAVING COUNT(*) > 1
    `);
    expect(dupActive.length).toBeGreaterThanOrEqual(3);

    const nullAlbumRotation = await sql.unsafe(`
      SELECT COUNT(*)::int AS n
        FROM "${SCHEMA}".rotation
       WHERE album_id IS NULL
         AND id BETWEEN 7000 AND 7099
    `);
    expect(nullAlbumRotation[0].n).toBeGreaterThanOrEqual(2);

    const futureKill = await sql.unsafe(`
      SELECT COUNT(*)::int AS n
        FROM "${SCHEMA}".rotation
       WHERE kill_date > CURRENT_DATE
         AND id BETWEEN 7000 AND 7099
    `);
    expect(futureKill[0].n).toBeGreaterThanOrEqual(1);

    const nullArtistLibrary = await sql.unsafe(`
      SELECT COUNT(*)::int AS n
        FROM "${SCHEMA}".library
       WHERE artist_name IS NULL
         AND id BETWEEN 7000 AND 7099
    `);
    expect(nullArtistLibrary[0].n).toBeGreaterThanOrEqual(1);

    const activeShows = await sql.unsafe(`
      SELECT COUNT(*)::int AS n
        FROM "${SCHEMA}".shows
       WHERE end_time IS NULL
         AND id BETWEEN 7000 AND 7099
    `);
    expect(activeShows[0].n).toBeGreaterThanOrEqual(2);

    const flowsheetPlayOrders = await sql.unsafe(`
      SELECT play_order
        FROM "${SCHEMA}".flowsheet
       WHERE show_id = 7003
       ORDER BY play_order ASC
    `);
    const orders = flowsheetPlayOrders.map((r) => r.play_order);
    expect(orders).toEqual(expect.arrayContaining([1, 2, 3, 4, 471]));

    const pendingMetadata = await sql.unsafe(`
      SELECT COUNT(*)::int AS n
        FROM "${SCHEMA}".flowsheet
       WHERE entry_type = 'track'
         AND artist_name IS NOT NULL
         AND metadata_attempt_at IS NULL
         AND id BETWEEN 7000 AND 7099
    `);
    expect(pendingMetadata[0].n).toBeGreaterThanOrEqual(1);
  });

  test('drizzle:migrate is idempotent against the loaded fixture', async () => {
    // Re-run drizzle-kit migrate against the same DB. Every existing
    // migration's hash is already in __drizzle_migrations, so this
    // call must be a structural no-op. If a future PR adds a
    // migration whose constraints the fixture violates, this call
    // fails because the new migration's `CREATE UNIQUE INDEX` (or
    // similar) reports a constraint error before drizzle records the
    // hash.
    //
    // We use `npx drizzle-kit migrate` directly (not the package
    // script) to avoid dotenvx's interactive prompting in test
    // environments that lack a .env. The required env vars are
    // already set by integration.setup.js / dotenvx in the harness.
    const env = {
      ...process.env,
      // Drizzle reads these via drizzle.config.ts.
      DB_HOST: process.env.DB_HOST || 'localhost',
      DB_PORT: process.env.DB_PORT || process.env.CI_DB_PORT || '5433',
      DB_NAME: process.env.DB_NAME || 'wxyc_db',
      DB_USERNAME: process.env.DB_USERNAME || 'test-user',
      DB_PASSWORD: process.env.DB_PASSWORD || 'test-pw',
    };

    let stdout;
    try {
      stdout = execSync('npx drizzle-kit migrate --config drizzle.config.ts', {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(
        `drizzle:migrate failed against the loaded shape fixture. ` +
          `If you just added a migration with a new constraint, the fixture row(s) it ` +
          `forbids are likely the cause — see tests/fixtures/shape.sql.\n\n` +
          `stdout: ${err.stdout?.toString() || ''}\n` +
          `stderr: ${err.stderr?.toString() || ''}`
      );
    }

    // Drizzle prints "[~] Pulling schema from database..." or
    // "Reading config file" but for a no-op migration prints no
    // CREATE/ALTER lines. We assert the run succeeded without
    // attempting to interpret the exact output, which has changed
    // across drizzle-kit versions.
    expect(typeof stdout).toBe('string');

    // Sanity: confirm no fixture rows were dropped by the migrate run.
    const fixtureCount = await sql.unsafe(`
      SELECT
        (SELECT COUNT(*)::int FROM "${SCHEMA}".rotation WHERE id BETWEEN 7000 AND 7099) AS rotation,
        (SELECT COUNT(*)::int FROM "${SCHEMA}".library  WHERE id BETWEEN 7000 AND 7099) AS library,
        (SELECT COUNT(*)::int FROM "${SCHEMA}".shows    WHERE id BETWEEN 7000 AND 7099) AS shows,
        (SELECT COUNT(*)::int FROM "${SCHEMA}".flowsheet WHERE id BETWEEN 7000 AND 7099) AS flowsheet
    `);
    expect(fixtureCount[0].rotation).toBeGreaterThanOrEqual(15);
    expect(fixtureCount[0].library).toBeGreaterThanOrEqual(10);
    expect(fixtureCount[0].shows).toBeGreaterThanOrEqual(4);
    expect(fixtureCount[0].flowsheet).toBeGreaterThanOrEqual(10);
  }, 60000);

  test('shape fixture file matches the documented edge-case shape', () => {
    // Cheap structural assertion against the fixture file itself, so
    // a future contributor who edits shape.sql can't silently remove
    // the load-bearing rows. The numeric thresholds match the issue
    // body's "Initial fixture content" list.
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
    const inserts = (raw.match(/INSERT INTO/gi) || []).length;
    expect(inserts).toBeGreaterThanOrEqual(5);

    // Targeted ON CONFLICT (...) DO NOTHING is the documented
    // idempotency contract — a bare ON CONFLICT DO NOTHING (no
    // target) would silently absorb the unique-constraint violations
    // the fixture exists to expose. Tables that use `ON CONFLICT (id)
    // DO NOTHING` are scoped to PK collisions only; the
    // genre_artist_crossreference junction table uses
    // `ON CONFLICT (artist_id, genre_id) DO NOTHING` because it has
    // no `id` column. Both forms are fine; only the BARE form is
    // forbidden.
    expect(raw).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
    const bareOnConflict = raw.match(/ON CONFLICT\s+DO\s+NOTHING/gi);
    expect(bareOnConflict).toBeNull();
  });
});
