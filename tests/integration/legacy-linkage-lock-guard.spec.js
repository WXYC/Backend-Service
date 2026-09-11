/**
 * BS#2413 — deterministic reproduction of the `legacy-linkage-resolve` lock
 * block, and proof that the guard clears it.
 *
 * ## What actually blocks
 *
 * `jobs/library-etl` never writes `rotation` or `flowsheet`, so the
 * contention is not on this job's own target rows. `wxyc_schema.library_watermark`
 * is a SINGLE-row table (`CONSTRAINT library_watermark_singleton CHECK ("id" = true)`,
 * migration 0104) that nine `FOR EACH STATEMENT` triggers all rewrite — among
 * them `touch_library_watermark` on `library` (0104, narrowed by 0142) and
 * `touch_library_watermark_from_rotation` (0105). Every statement that fires
 * one takes an exclusive row lock on that ONE row and holds it until COMMIT.
 * `library-etl` wraps its whole import in a single transaction, grabs the row
 * on its first `library` write, and holds it for 13-15 minutes;
 * `legacy-linkage-resolve`'s rotation UPDATE fires the rotation trigger, asks
 * for the same row, waits, and is cancelled at the image's 300 s
 * `DB_STATEMENT_TIMEOUT_MS`.
 *
 * **The non-obvious half: a statement-level trigger fires on `UPDATE 0`.** A
 * rotation pass whose cohort is empty still takes the lock and still dies —
 * which is why ~98% of this job's runs were exposed, not just the rare ones
 * with repair work. The "matching ZERO rows" case below pins exactly that,
 * because it is the claim the cheapest lever (the candidate pre-check) rests
 * on: if an empty cohort were already safe, that lever would be pointless.
 *
 * This is NOT the FK-on-`library` reproduction an earlier revision of #2413
 * described. That story — `library-etl`'s `ON CONFLICT … DO UPDATE` conflict
 * arm holding `FOR UPDATE` on a committed `library` row the rotation cohort's
 * FK check wants at `FOR KEY SHARE` — was falsified by the job's own logs:
 * `updated via legacy-id conflict 0` on all six of the observed failing
 * slots, so no conflict arm ran and no such lock was ever taken. Building the
 * test that way would reproduce a GREEN run.
 *
 * The FK path is real, just not what fired here, and against `library-etl` it
 * is the flowsheet pass's only exposure — `flowsheet` carries no
 * `library_watermark` trigger — which is why the flowsheet pass survives on
 * its DATA rather than on any design property.
 *
 * **`flowsheet` is not lock-free, though, and the flowsheet cases below hold
 * the right row.** It has its own singleton, `flowsheet_watermark`
 * (`flowsheet_watermark_singleton CHECK ("id" = true)`, migration 0084),
 * rewritten by `touch_flowsheet_watermark` — equally `FOR EACH STATEMENT`,
 * equally fired on `UPDATE 0`. Holding `library_watermark` cannot block the
 * flowsheet drain at all (`UPDATE library … WHERE id = 7000` takes only
 * `FOR NO KEY UPDATE`, which does not conflict with the FK check's
 * `FOR KEY SHARE`), so a flowsheet case built on that holder passes whether
 * or not the pass is guarded.
 *
 * ## What this spec asserts
 *
 * 1. A held watermark row blocks a rotation UPDATE that matches ZERO rows —
 *    and, on the flowsheet singleton, a flowsheet UPDATE that matches zero.
 * 2. It blocks the production rotation CTE.
 * 3. `SET LOCAL lock_timeout` converts that block into `55P03` in well under
 *    the statement timeout, on both passes.
 * 4. The candidate pre-check COUNT is not blocked at all — the other lever.
 * 5. With no holder, the guarded statement links the probe row.
 *
 * Postgres-dependent, like `library-watermark-parents.spec.js`: every
 * statement is raw SQL against the test DB on two independent connections,
 * because the whole phenomenon is cross-session lock behaviour that no mock
 * can model.
 *
 * **Nothing here commits.** The transcribed statements are the production
 * CTEs, unbounded by construction, and this suite runs `--runInBand` against
 * one shared database — see `runGuarded`'s docblock.
 *
 * The SQL below transcribes `jobs/legacy-linkage-resolve/job.ts`; the job's
 * own statement text is pinned separately by the exact-match allowlist in
 * `tests/unit/jobs/legacy-linkage-resolve/job.test.ts`. This spec is about
 * the lock, not the predicates.
 */

const { readFileSync } = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Reuse the shape-fixture library row (id 7000) for valid FK values and as
// the row the "holder" session writes to fire the library watermark trigger.
const SHAPE_FIXTURE_LIBRARY_ID = 7000;
const TITLE_PREFIX = 'BS#2413 Lock Guard Probe';
// Legacy id the probe library + rotation rows share, so the probe rotation row
// is a genuine member of the production cohort's JOIN.
const PROBE_LEGACY_RELEASE_ID = 24130001;

// Must match `LINKAGE_LOCK_TIMEOUT_MS` in job.ts (750 ms, below the default
// 1 s `deadlock_timeout`). Duplicated as a literal rather than imported —
// job.ts is ESM TypeScript and this suite is CommonJS — and pinned against
// job.ts's source by the first test below so the two cannot drift silently.
const LOCK_TIMEOUT_MS = 750;

// Stands in for the production image's `DB_STATEMENT_TIMEOUT_MS=300000`. Small
// enough to keep the suite fast, large enough that a `55P03` at 750 ms is
// unambiguously the lock timeout firing first and not a race between the two.
//
// Each "blocks" case below holds an exclusive lock on the `library_watermark`
// singleton for this long, which every `library`/`rotation` write in the
// database queues behind. CI runs the integration suite `--runInBand`
// (`scripts/ci-test.sh`), so nothing else is in flight; keep this value small
// anyway, for the `jest.parallel.config.json` path.
const STATEMENT_TIMEOUT_MS = 3000;

const SQLSTATE_QUERY_CANCELED = '57014'; // statement_timeout — today's failure
const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03'; // lock_timeout — the fixed behaviour

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    // One connection per client so an explicit BEGIN … COMMIT spans the
    // statements that follow it rather than landing on a pooled sibling.
    max: 1,
  });
}

/** The rotation pass's statement, transcribed from job.ts. */
const ROTATION_DRAIN_SQL = `
  WITH cohort AS (
    SELECT DISTINCT r.id
    FROM "${SCHEMA}".rotation r
    JOIN "${SCHEMA}".library l ON r.legacy_library_release_id = l.legacy_release_id
    WHERE r.legacy_library_release_id IS NOT NULL
      AND r.album_id IS NULL
  ),
  upd AS (
    UPDATE "${SCHEMA}".rotation r
    SET album_id = l.id, artist_name = NULL, album_title = NULL, record_label = NULL
    FROM "${SCHEMA}".library l, cohort c
    WHERE r.id = c.id
      AND r.legacy_library_release_id = l.legacy_release_id
      AND r.album_id IS NULL
    RETURNING 1
  )
  SELECT (SELECT COUNT(*)::int FROM cohort) AS candidates,
         (SELECT COUNT(*)::int FROM upd) AS resolved`;

/** The flowsheet pass's statement, transcribed from job.ts. */
const FLOWSHEET_DRAIN_SQL = `
  WITH cohort AS (
    SELECT DISTINCT f.id
    FROM "${SCHEMA}".flowsheet f
    JOIN "${SCHEMA}".library l ON f.legacy_release_id = l.legacy_release_id
    WHERE f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  ),
  upd AS (
    UPDATE "${SCHEMA}".flowsheet f
    SET album_id = l.id
    FROM "${SCHEMA}".library l, cohort c
    WHERE f.id = c.id
      AND f.legacy_release_id = l.legacy_release_id
      AND f.album_id IS NULL
    RETURNING 1
  )
  SELECT (SELECT COUNT(*)::int FROM cohort) AS candidates,
         (SELECT COUNT(*)::int FROM upd) AS resolved`;

/** The rotation pass's candidate pre-check, transcribed from job.ts. */
const ROTATION_COUNT_SQL = `
  SELECT COUNT(*)::int AS count
  FROM "${SCHEMA}".rotation r
  JOIN "${SCHEMA}".library l ON r.legacy_library_release_id = l.legacy_release_id
  WHERE r.legacy_library_release_id IS NOT NULL
    AND r.album_id IS NULL`;

/**
 * An UPDATE on `rotation` that provably matches no rows (`id = -1`; the column
 * is a `serial`). It writes nothing, takes no row lock on `rotation` itself,
 * and fires no FK check — yet `touch_library_watermark_from_rotation` is
 * `FOR EACH STATEMENT`, so it still contends for the watermark row. This
 * isolates the `UPDATE 0` claim from whatever the ambient cohort happens to
 * hold in the test database.
 */
const ZERO_ROW_ROTATION_UPDATE = `UPDATE "${SCHEMA}".rotation SET album_id = album_id WHERE id = -1`;

describe('legacy-linkage-resolve lock guard (BS#2413)', () => {
  /** The session that plays `library-etl`: opens a transaction and sits on it. */
  let holder;
  /** The session that plays `legacy-linkage-resolve`. */
  let worker;
  let probeLibraryId;
  let probeRotationId;

  const cleanupProbes = async (sql) => {
    // rotation.album_id references library.id ON DELETE CASCADE, so dropping
    // the probe library row reaps its probe rotation row. The unlinked probe
    // rotation row (album_id IS NULL) is not reachable that way, hence the
    // explicit DELETE on the legacy id this spec owns.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".rotation WHERE legacy_library_release_id = $1`, [
      PROBE_LEGACY_RELEASE_ID,
    ]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
  };

  beforeAll(async () => {
    holder = makeSql();
    worker = makeSql();

    const fkRows = await worker.unsafe(`SELECT artist_id, genre_id, format_id FROM "${SCHEMA}".library WHERE id = $1`, [
      SHAPE_FIXTURE_LIBRARY_ID,
    ]);
    const fk = fkRows[0];
    if (!fk) {
      throw new Error(
        `shape fixture library row ${SHAPE_FIXTURE_LIBRARY_ID} not found in schema "${SCHEMA}" — globalSetup should load tests/fixtures/shape.sql before any spec`
      );
    }

    await cleanupProbes(worker);

    const lib = await worker.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, legacy_release_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [fk.artist_id, fk.genre_id, fk.format_id, `${TITLE_PREFIX} release`, 0, PROBE_LEGACY_RELEASE_ID]
    );
    probeLibraryId = lib[0].id;

    // The unlinked half of the race this job repairs: a rotation row whose
    // library row landed second, so its webhook write could not resolve
    // `album_id`.
    const rot = await worker.unsafe(
      `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin, legacy_library_release_id, artist_name, album_title)
       VALUES (NULL, 'H', $1, $2, $3) RETURNING id`,
      [PROBE_LEGACY_RELEASE_ID, `${TITLE_PREFIX} artist`, `${TITLE_PREFIX} release`]
    );
    probeRotationId = rot[0].id;
  });

  afterAll(async () => {
    if (holder) {
      await holder.unsafe('ROLLBACK').catch(() => {});
      await holder.end();
    }
    if (worker) {
      await cleanupProbes(worker);
      await worker.end();
    }
  });

  /**
   * Reproduces `library-etl`'s hold: one open transaction whose first
   * `library` write fires `touch_library_watermark` and takes the singleton
   * row, held until the caller releases it. Deliberately goes through the
   * real trigger rather than writing `library_watermark` directly, so the
   * mechanism under test is the one production runs.
   */
  const holdWatermark = async () => {
    await holder.unsafe('BEGIN');
    await holder.unsafe(`UPDATE "${SCHEMA}".library SET album_title = album_title WHERE id = $1`, [
      SHAPE_FIXTURE_LIBRARY_ID,
    ]);
  };

  /**
   * The flowsheet pass's equivalent hold. `flowsheet` carries NO
   * `library_watermark` trigger, and `UPDATE library … WHERE id = 7000` takes
   * only `FOR NO KEY UPDATE`, which does not conflict with the `FOR KEY SHARE`
   * the flowsheet FK check takes — so `holdWatermark` above cannot block the
   * flowsheet drain at all, and a "does the guard cover flowsheet?" test built
   * on it asserts nothing.
   *
   * What the flowsheet drain really contends for is `flowsheet_watermark`:
   * its own single-row table (`flowsheet_watermark_singleton CHECK (id = true)`,
   * migration 0084), rewritten by `touch_flowsheet_watermark`, an equally
   * `FOR EACH STATEMENT` trigger fired by every `flowsheet` write — including,
   * as below, one matching zero rows. A live DJ's play insert and
   * `flowsheet-metadata-backfill` are the production holders of that row.
   */
  const holdFlowsheetWatermark = async () => {
    await holder.unsafe('BEGIN');
    // `id = -1` matches nothing (the column is a serial), so this writes no
    // flowsheet row — it exists purely to fire the statement trigger and take
    // the singleton, which is the same `UPDATE 0` claim the rotation case pins.
    await holder.unsafe(`UPDATE "${SCHEMA}".flowsheet SET album_id = album_id WHERE id = -1`);
  };

  const releaseWatermark = async () => {
    // ROLLBACK, not COMMIT: `album_title = album_title` is a no-op write, but
    // rolling back keeps this spec from touching the shape fixture's row
    // version at all.
    await holder.unsafe('ROLLBACK');
  };

  /**
   * Runs `statement` the way today's production code does — bare, with only
   * the server-side statement timeout standing between it and forever.
   * Returns the rejection.
   */
  const runUnguarded = async (statement) => {
    try {
      await worker.unsafe('BEGIN');
      await worker.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await worker.unsafe(statement);
      // ROLLBACK for the same reason `runGuarded` does — see its docblock.
      // These cases are expected to be cancelled before they get here anyway.
      await worker.unsafe('ROLLBACK');
      return null;
    } catch (error) {
      await worker.unsafe('ROLLBACK').catch(() => {});
      return error;
    }
  };

  /**
   * Runs `statement` the way the fix does: same transaction, same statement
   * timeout, plus the `SET LOCAL lock_timeout` guard ahead of it.
   *
   * **Ends in ROLLBACK, not COMMIT, unless `commit: true` is passed.** The
   * statements transcribed above are the PRODUCTION CTEs, unbounded by
   * construction: `ROTATION_DRAIN_SQL` links every unlinked rotation row in
   * the database and NULLs its denormalized `artist_name`/`album_title`/
   * `record_label`, and `FLOWSHEET_DRAIN_SQL` does the same across the whole
   * flowsheet table (and bumps `flowsheet_watermark`). Committing that from a
   * spec mutates rows other specs own — the integration suite runs
   * `--runInBand` against one shared database, and `cleanupProbes` only knows
   * about this spec's two probe rows. Rolling back keeps the lock behaviour
   * under test (locks are taken and released exactly the same way) while
   * leaving the ambient cohort untouched; a caller that must observe the
   * write reads it back INSIDE the transaction, before the rollback.
   */
  const runGuarded = async (statement, { commit = false, readBack } = {}) => {
    const startedAt = Date.now();
    try {
      await worker.unsafe('BEGIN');
      await worker.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await worker.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      const rows = await worker.unsafe(statement);
      const readBackRows = readBack ? await readBack(worker) : null;
      await worker.unsafe(commit ? 'COMMIT' : 'ROLLBACK');
      return { rows, readBackRows, error: null, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      await worker.unsafe('ROLLBACK').catch(() => {});
      return { rows: null, readBackRows: null, error, elapsedMs: Date.now() - startedAt };
    }
  };

  test('the lock timeout this spec exercises is the one job.ts actually sets', () => {
    // The CommonJS/ESM boundary forces the 750 above to be a transcription.
    // Pin it against the source so a change to `LINKAGE_LOCK_TIMEOUT_MS`
    // cannot leave this spec silently proving a timeout production no longer
    // uses. The statement TEXT is pinned separately, by the exact-match
    // allowlist in tests/unit/jobs/legacy-linkage-resolve/job.test.ts.
    const jobSource = readFileSync(path.resolve(__dirname, '../../jobs/legacy-linkage-resolve/job.ts'), 'utf8');
    expect(jobSource).toContain(`export const LINKAGE_LOCK_TIMEOUT_MS = ${LOCK_TIMEOUT_MS};`);
  });

  describe('the block, reproduced', () => {
    afterEach(async () => {
      await releaseWatermark().catch(() => {});
    });

    test('a rotation UPDATE matching ZERO rows still blocks — a statement trigger fires on UPDATE 0', async () => {
      await holdWatermark();

      const error = await runUnguarded(ZERO_ROW_ROTATION_UPDATE);

      // This is the claim the FK story cannot make and the watermark story
      // requires: no row matched, no FK check ran, nothing was written, and
      // the statement still waited until it was cancelled.
      expect(error).not.toBeNull();
      expect(error.code).toBe(SQLSTATE_QUERY_CANCELED);
    });

    test('a flowsheet UPDATE matching ZERO rows blocks too — flowsheet has its own singleton', async () => {
      // The flowsheet half of the `UPDATE 0` claim. It is what makes the
      // pre-check load-bearing on BOTH passes rather than only on rotation:
      // an empty flowsheet cohort is safe because no UPDATE is issued, not
      // because `flowsheet` has no statement trigger to fire.
      await holdFlowsheetWatermark();

      const error = await runUnguarded(`UPDATE "${SCHEMA}".flowsheet SET album_id = album_id WHERE id = -2`);

      expect(error).not.toBeNull();
      expect(error.code).toBe(SQLSTATE_QUERY_CANCELED);
    });

    test('the production rotation CTE blocks on the same row', async () => {
      await holdWatermark();

      const error = await runUnguarded(ROTATION_DRAIN_SQL);

      expect(error).not.toBeNull();
      expect(error.code).toBe(SQLSTATE_QUERY_CANCELED);
    });
  });

  describe('the guard, verified', () => {
    afterEach(async () => {
      await releaseWatermark().catch(() => {});
    });

    test('lock_timeout turns the rotation block into 55P03 in well under the statement timeout', async () => {
      await holdWatermark();

      const { error, elapsedMs } = await runGuarded(ROTATION_DRAIN_SQL);

      expect(error).not.toBeNull();
      expect(error.code).toBe(SQLSTATE_LOCK_NOT_AVAILABLE);
      // The point of the lever: seconds, not the 300 s burn production saw.
      // Generous upper bound so a loaded CI box does not flake it, but still
      // decisively below `STATEMENT_TIMEOUT_MS`.
      expect(elapsedMs).toBeLessThan(STATEMENT_TIMEOUT_MS);
    });

    test('the guard covers the flowsheet pass too, not only rotation', async () => {
      // Holds `flowsheet_watermark`, NOT `library_watermark` — see
      // `holdFlowsheetWatermark`. Held through `library_watermark` this case
      // never blocks at all and passes whether or not the flowsheet pass is
      // guarded, which is the one thing it is supposed to prove.
      await holdFlowsheetWatermark();

      const { error, elapsedMs } = await runGuarded(FLOWSHEET_DRAIN_SQL);

      expect(error).not.toBeNull();
      expect(error.code).toBe(SQLSTATE_LOCK_NOT_AVAILABLE);
      expect(elapsedMs).toBeLessThan(STATEMENT_TIMEOUT_MS);
    });

    test('the candidate pre-check is not blocked at all — a plain SELECT fires no trigger', async () => {
      await holdWatermark();

      const { rows, error, elapsedMs } = await runGuarded(ROTATION_COUNT_SQL);

      // The second lever. On the ~98% of runs whose cohort is empty, this is
      // the ONLY statement the pass issues, so those runs cannot collide at
      // all — which is exactly the property BS#2071 removed by making the
      // UPDATE unconditional.
      expect(error).toBeNull();
      expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1); // the probe row
      // Bounded by the STATEMENT timeout, not the 750 ms lock timeout. The
      // assertion's claim is "was not blocked"; a `LOCK_TIMEOUT_MS` ceiling
      // adds a flake surface instead, because `elapsedMs` starts before BEGIN
      // and so has to cover five round trips plus the rotation×library join
      // on whatever the CI box is doing that minute. Same bound as the
      // sibling assertion above, for the same reason.
      expect(elapsedMs).toBeLessThan(STATEMENT_TIMEOUT_MS);
    });
  });

  test('with the holder released, the guarded rotation pass links the probe row', async () => {
    // Read back INSIDE the transaction, then roll back. `ROTATION_DRAIN_SQL`
    // is the unbounded production CTE: committing it here would link every
    // ambient unlinked rotation row in the shared integration database and
    // NULL its denormalized display columns, which is a side effect on rows
    // other specs own — see `runGuarded`'s docblock.
    const { rows, readBackRows, error } = await runGuarded(ROTATION_DRAIN_SQL, {
      readBack: (sql) =>
        sql.unsafe(`SELECT album_id, artist_name, album_title, record_label FROM "${SCHEMA}".rotation WHERE id = $1`, [
          probeRotationId,
        ]),
    });

    expect(error).toBeNull();
    expect(Number(rows[0].resolved)).toBeGreaterThanOrEqual(1);

    const linked = readBackRows;
    expect(linked[0].album_id).toBe(probeLibraryId);
    // The rotation pass clears the denormalized display columns the row
    // carried while it was unlinked.
    expect(linked[0].artist_name).toBeNull();
    expect(linked[0].album_title).toBeNull();
    expect(linked[0].record_label).toBeNull();
  });
});
