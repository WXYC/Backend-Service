/**
 * BS#2594 — a `library` row deleted mid-statement by a concurrent
 * `DELETE /library/:id` must retire the linkage candidate that was about to
 * reference it, not fail the whole run.
 *
 * ## The race, reproduced
 *
 * `resolveFlowsheetAlbumIds`/`resolveRotationAlbumIds` (`jobs/legacy-linkage-
 * resolve/job.ts`) UPDATE `flowsheet.album_id`/`rotation.album_id` to a
 * `library.id` the row didn't reference before. That UPDATE fires the FK
 * insert-check trigger, which needs `FOR KEY SHARE` on the specific `library`
 * row it is about to point at. If a librarian's `DELETE /library/:id` holds
 * that row (its own row lock, taken before commit) when the check runs, the
 * check blocks; if the delete then COMMITS before this job's `lock_timeout`
 * elapses, the check unblocks, re-evaluates against now-committed state, finds
 * the row gone, and raises `23503` — a wholly different shape from the
 * `55P03`/`40P01` lock-contention path `legacy-linkage-lock-guard.spec.js`
 * covers.
 *
 * **Reachability differs by pass.** The rotation pass's FK check has always
 * been reachable this way — nothing ever refused a `library` delete on
 * rotation's account. BS#2565 is what made the FLOWSHEET pass reachable: it
 * removed `DELETE /library/:id`'s old refusal to delete a `library` row any
 * `flowsheet` row still referenced, which had made a flowsheet-linked row
 * effectively undeletable and this race effectively flowsheet-impossible.
 * The two tests below exercise both passes because the two are exposed
 * differently, not identically.
 *
 * This is the same two-connection (`holder`/`worker`) pattern as that spec,
 * transcribing the same production CTEs. What's different here is the
 * interleaving: `holder` must still be mid-DELETE (uncommitted) when
 * `worker`'s statement reaches the FK check, then commit while `worker` is
 * blocked on it — not before `worker` starts, and not after it gives up. That
 * interleaving is enforced with a THIRD connection (`observer`) polling
 * `pg_stat_activity` for `worker`'s backend to actually enter a lock wait
 * before `holder` is allowed to commit (`waitUntilBlocked`) — not a fixed
 * sleep, which would make this spec's very race two-sided: too short and
 * `holder` commits before `worker` is even waiting, too long and `worker`'s
 * own `lock_timeout` could fire first and misclassify the case as lock
 * contention instead of a retired candidate.
 *
 * Pure SQL, Postgres-dependent, `--runInBand` — cross-session lock timing, not
 * something a mock can model. `isRetiredLinkageCandidateError`'s
 * classification of the resulting error (constraint-scoped, not
 * SQLSTATE-only) is unit-tested against hand-built doubles in
 * `tests/unit/jobs/legacy-linkage-resolve/job.test.ts`; this spec instead
 * `require`s the REAL compiled classifier (`jobs/legacy-linkage-resolve/
 * retired-candidate.ts`, built to `dist/retired-candidate.cjs` — see
 * `tsup.config.ts`) and calls it against the error a real concurrent delete
 * actually produces.
 *
 * That error arrives via a RAW `postgres` client (`worker`, no drizzle in the
 * path), so on its own this spec proves only the fallback half of
 * `extractSqlState`/`extractConstraintName`'s two-level read: `code` and
 * `constraint_name` sit at the TOP level here, never under `.cause`. Every
 * production rejection takes the OTHER branch instead — drizzle's
 * `DrizzleQueryError` wraps every query rejection unconditionally (see
 * `sqlstate.ts`'s docstring), so `.cause` is where the real SQLSTATE and
 * constraint name live in production, and `error.code`/`error.constraint_name`
 * are `undefined` there. The rotation test below adds one more assertion that
 * re-wraps that SAME real driver error in the `.cause` shape and
 * re-classifies it, so this spec proves both branches against a real error —
 * never a hand-built double asserting the same two fields against itself —
 * and the wrapped-shape gap `sqlstate.ts` warns about (a predicate proven
 * only against hand-built doubles, shipped as dead code against a green
 * suite once already) cannot recur here.
 */

const path = require('path');
const postgres = require('postgres');

const distDir = path.join(__dirname, '..', '..', 'jobs', 'legacy-linkage-resolve', 'dist');
// The REAL compiled classifier — no reimplementation — so what this spec
// proves is the behavior that ships, not a second hand-built copy of the
// SQLSTATE-plus-constraint-name check (BS#2594 review). See
// `retired-candidate.ts`'s docstring and `shared/database/src/sqlstate.ts`'s
// (a predicate proven only against hand-built doubles shipped as dead code
// against a green suite once already).
const { isRetiredLinkageCandidateError } = require(path.join(distDir, 'retired-candidate.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SHAPE_FIXTURE_LIBRARY_ID = 7000;
const TITLE_PREFIX = 'BS#2594 Retired Candidate Probe';
const ROTATION_LEGACY_RELEASE_ID = 25940001;
const FLOWSHEET_LEGACY_RELEASE_ID = 25940002;
// `play_order` is NOT NULL on the schema with no default (schema.ts). This
// spec's flowsheet probe carries no `show_id` (same upstream-permitted NULL
// shape as `enrichment-worker-claim.spec.js`), so there is no per-show
// ordering to respect — a high constant unique to this spec is enough to
// avoid colliding with sibling specs' own bands (e.g. `enrichment-worker-
// claim.spec.js`'s 99999, `flowsheet-etl-setwhere.spec.js`'s 990xx).
const FLOWSHEET_PLAY_ORDER = 2594000;

// Same lever as `legacy-linkage-lock-guard.spec.js`: below the default 1s
// `deadlock_timeout`, must match `LINKAGE_LOCK_TIMEOUT_MS` in job.ts.
const LOCK_TIMEOUT_MS = 750;
const STATEMENT_TIMEOUT_MS = 3000;
// Polling cadence/ceiling for `waitUntilBlocked` below. Not a timing
// assumption about the race itself (see that function's docblock) — just how
// fast `observer` re-checks, and how long it waits before concluding
// something is actually wrong rather than merely slow.
const BLOCK_POLL_INTERVAL_MS = 20;
const BLOCK_POLL_TIMEOUT_MS = 2000;

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 1,
  });
}

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

describe('legacy-linkage-resolve stands down on a retired candidate (BS#2594)', () => {
  let holder;
  let worker;
  /** Third connection, used only to poll `pg_stat_activity` — see `waitUntilBlocked`. */
  let observer;

  const cleanupProbes = async (sql) => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".rotation WHERE legacy_library_release_id = $1`, [
      ROTATION_LEGACY_RELEASE_ID,
    ]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE legacy_release_id = $1`, [FLOWSHEET_LEGACY_RELEASE_ID]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
  };

  /**
   * Polls `pg_stat_activity` on a THIRD connection until `pid` shows
   * `wait_event_type = 'Lock'`, or throws once `BLOCK_POLL_TIMEOUT_MS`
   * elapses without ever observing it.
   *
   * This replaces a fixed sleep between `holder`'s DELETE and its COMMIT.
   * The race this spec reproduces is two-sided — `worker`'s UPDATE must
   * still be waiting on `holder`'s row lock when `holder` commits, not
   * merely "probably has been for `N` ms by now" — so a fixed sleep is
   * inherently a coin flip against CI scheduling noise: too short and
   * `worker` hasn't reached the lock wait yet (this row lock is `holder`'s;
   * see below); too long risks `worker`'s own `LOCK_TIMEOUT_MS` firing first
   * and misclassifying the case as lock contention instead of a retired
   * candidate. Polling for the actual OS-visible blocked state removes both
   * failure modes: `holder` commits exactly once `worker` is provably
   * waiting on it, never before and never (barring a genuinely broken
   * interleaving) after. Same technique Postgres's own isolation tester
   * uses to serialize concurrent sessions in its specs.
   *
   * `observer` shares `worker`'s role (`DB_USERNAME`), so `pg_stat_activity`
   * hides nothing from it — the visibility restriction on that view's
   * `query` column is role-scoped, not backend-scoped, and this only reads
   * `wait_event_type` regardless.
   */
  const waitUntilBlocked = async (pid) => {
    const deadline = Date.now() + BLOCK_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const rows = await observer.unsafe('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (rows[0]?.wait_event_type === 'Lock') return;
      await new Promise((r) => setTimeout(r, BLOCK_POLL_INTERVAL_MS));
    }
    throw new Error(
      `worker (pid ${pid}) never entered a lock wait within ${BLOCK_POLL_TIMEOUT_MS}ms — the interleaving this spec ` +
        'depends on did not happen, so the resulting error (if any) would not be evidence of anything. This is a ' +
        'genuine failure, not a flake: either the FK check no longer blocks on a concurrent uncommitted DELETE the ' +
        'way this spec assumes, or something upstream is badly overloaded.'
    );
  };

  /** Inserts a fresh, unlinked library + candidate row pair for one pass. */
  const seedProbe = async (sql, { legacyReleaseId, table }) => {
    const fkRows = await sql.unsafe(`SELECT artist_id, genre_id, format_id FROM "${SCHEMA}".library WHERE id = $1`, [
      SHAPE_FIXTURE_LIBRARY_ID,
    ]);
    const fk = fkRows[0];
    if (!fk) {
      throw new Error(`shape fixture library row ${SHAPE_FIXTURE_LIBRARY_ID} not found in schema "${SCHEMA}"`);
    }

    const lib = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, legacy_release_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [fk.artist_id, fk.genre_id, fk.format_id, `${TITLE_PREFIX} ${table}`, 0, legacyReleaseId]
    );
    const libraryId = lib[0].id;

    if (table === 'rotation') {
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".rotation (album_id, rotation_bin, legacy_library_release_id, artist_name, album_title)
         VALUES (NULL, 'H', $1, $2, $3)`,
        [legacyReleaseId, `${TITLE_PREFIX} artist`, `${TITLE_PREFIX} release`]
      );
    } else {
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}".flowsheet (legacy_release_id, artist_name, track_title, play_order)
         VALUES ($1, $2, $3, $4)`,
        [legacyReleaseId, `${TITLE_PREFIX} artist`, `${TITLE_PREFIX} track`, FLOWSHEET_PLAY_ORDER]
      );
    }
    return libraryId;
  };

  beforeAll(async () => {
    holder = makeSql();
    worker = makeSql();
    observer = makeSql();
    await cleanupProbes(worker);
    // postgres.js connects lazily: without this, `observer`'s FIRST-EVER
    // statement (TCP connect + startup + SCRAM auth, then the query) would be
    // its `waitUntilBlocked` poll inside `runAgainstRacingDelete` — issued
    // AFTER `worker`'s blocking statement has already gone out, i.e. inside
    // `worker`'s own ~750ms LOCK_TIMEOUT_MS window. `holder` is warmed by its
    // own BEGIN/DELETE before that window opens; `observer` had no equivalent
    // warm-up and paid handshake cost against the very clock it exists to be
    // immune to. On a loaded runner that overrun means `worker` raises 55P03
    // instead of 23503, and `waitUntilBlocked` polls a backend that already
    // stopped waiting until it times out.
    await observer.unsafe('SELECT 1');
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
    if (observer) {
      await observer.end();
    }
  });

  afterEach(async () => {
    await cleanupProbes(worker);
  });

  /**
   * Runs `statement` under the same lock guard `runGuardedDrain` applies in
   * production, and starts a concurrent `DELETE` on `libraryId` via `holder`
   * that stays open (uncommitted) until `worker` is OBSERVED blocked on it
   * (`waitUntilBlocked`), so the FK check `statement`'s UPDATE fires blocks
   * on `holder`'s row lock and then observes the row gone once `holder`
   * commits — never before `worker` actually reaches that wait, and never
   * after `worker`'s own `LOCK_TIMEOUT_MS` could have fired first.
   *
   * `worker`'s own backend pid is read up front (`pg_backend_pid()`, same
   * connection, before the blocking statement is issued) so `waitUntilBlocked`
   * knows which `pg_stat_activity` row is the one that matters — `worker`'s
   * pool is `max: 1`, so this pid is stable for every statement `worker`
   * issues for the rest of this call.
   */
  const runAgainstRacingDelete = async (statement, libraryId) => {
    await holder.unsafe('BEGIN');
    await holder.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = $1`, [libraryId]);

    await worker.unsafe('BEGIN');
    await worker.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await worker.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    const [{ pid: workerPid }] = await worker.unsafe('SELECT pg_backend_pid() AS pid');

    const workerPromise = (async () => {
      try {
        const rows = await worker.unsafe(statement);
        await worker.unsafe('ROLLBACK');
        return { rows, error: null };
      } catch (error) {
        await worker.unsafe('ROLLBACK').catch(() => {});
        return { rows: null, error };
      }
    })();

    try {
      await waitUntilBlocked(workerPid);
    } catch (blockedError) {
      // `worker` is presumably still parked in its lock wait (or already
      // unblocked some other way) — either way, `holder` must not stay open.
      // Leaving it uncommitted would deadlock the very next `afterEach`
      // (`cleanupProbes` DELETEs the same library row via `worker`), turning
      // one clear failure into a hung suite. Rolling back also lets
      // `workerPromise` resolve on its own: the row reappears, so `worker`'s
      // FK check succeeds instead of raising.
      await holder.unsafe('ROLLBACK').catch(() => {});
      await workerPromise.catch(() => {});
      throw blockedError;
    }

    await holder.unsafe('COMMIT');

    return workerPromise;
  };

  test('a concurrent delete mid-statement produces 23503 on rotation_album_id_library_id_fk, not a lock timeout', async () => {
    const libraryId = await seedProbe(worker, { legacyReleaseId: ROTATION_LEGACY_RELEASE_ID, table: 'rotation' });

    const { error } = await runAgainstRacingDelete(ROTATION_DRAIN_SQL, libraryId);

    expect(error).not.toBeNull();
    expect(error.code).toBe('23503');
    expect(error.constraint_name).toBe('rotation_album_id_library_id_fk');
    // The real predicate, against the real driver error — not a hand-built
    // double asserting the same two fields against itself.
    expect(isRetiredLinkageCandidateError(error)).toBe(true);

    // Same real driver error, re-wrapped in the shape drizzle's
    // `DrizzleQueryError` actually produces (`.cause` carries the driver
    // error; the wrapper's own `code`/`constraint_name` are `undefined`) —
    // the branch of `extractSqlState`/`extractConstraintName` every
    // production `tx.execute` rejection takes, which the bare `error` above
    // never exercises. Proves the `.cause` branch against a REAL error, not
    // a hand-built double asserting the same two fields against itself.
    const wrapped = { message: 'Failed query', code: undefined, constraint_name: undefined, cause: error };
    expect(isRetiredLinkageCandidateError(wrapped)).toBe(true);
  });

  test('a concurrent delete mid-statement produces 23503 on flowsheet_album_id_library_id_fk too', async () => {
    const libraryId = await seedProbe(worker, { legacyReleaseId: FLOWSHEET_LEGACY_RELEASE_ID, table: 'flowsheet' });

    const { error } = await runAgainstRacingDelete(FLOWSHEET_DRAIN_SQL, libraryId);

    expect(error).not.toBeNull();
    expect(error.code).toBe('23503');
    expect(error.constraint_name).toBe('flowsheet_album_id_library_id_fk');
    // The real predicate, against the real driver error.
    expect(isRetiredLinkageCandidateError(error)).toBe(true);
  });

  test('retried on the next slot, with no racing delete, the retired candidate is gone and the rest of the cohort still drains', async () => {
    // The candidate whose library row was deleted is retired for good — it
    // has no legacy_release_id match left to join — but a second, untouched
    // probe in the same cohort proves the retry isn't just "nothing left to
    // do": the job's whole point is that a stand-down costs one cycle, not
    // the candidates that weren't in the collision.
    const deletedLibraryId = await seedProbe(worker, {
      legacyReleaseId: ROTATION_LEGACY_RELEASE_ID,
      table: 'rotation',
    });
    await worker.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = $1`, [deletedLibraryId]);
    const survivingLibraryId = await seedProbe(worker, {
      legacyReleaseId: FLOWSHEET_LEGACY_RELEASE_ID,
      table: 'rotation',
    });

    await worker.unsafe('BEGIN');
    await worker.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    const rows = await worker.unsafe(ROTATION_DRAIN_SQL);
    const linked = await worker.unsafe(
      `SELECT album_id FROM "${SCHEMA}".rotation WHERE legacy_library_release_id = $1`,
      [FLOWSHEET_LEGACY_RELEASE_ID]
    );
    const retired = await worker.unsafe(
      `SELECT album_id FROM "${SCHEMA}".rotation WHERE legacy_library_release_id = $1`,
      [ROTATION_LEGACY_RELEASE_ID]
    );
    await worker.unsafe('ROLLBACK');

    expect(Number(rows[0].resolved)).toBeGreaterThanOrEqual(1);
    expect(linked[0].album_id).toBe(survivingLibraryId);
    // The retired candidate's row still exists (nothing here deletes
    // `rotation` rows) but must stay unlinked forever: its library row is
    // gone, so it can never again satisfy the cohort JOIN and the drain must
    // not have touched its `album_id`.
    expect(retired).toHaveLength(1);
    expect(retired[0].album_id).toBeNull();
  });
});
