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
 * covers, and unreachable before BS#2565 removed the delete's
 * flowsheet-references refusal.
 *
 * This is the same two-connection (`holder`/`worker`) pattern as that spec,
 * transcribing the same production CTEs. What's different here is the
 * interleaving: `holder` must still be mid-DELETE (uncommitted) when
 * `worker`'s statement reaches the FK check, then commit while `worker` is
 * blocked on it — not before `worker` starts, and not after it gives up.
 *
 * Pure SQL, Postgres-dependent, `--runInBand` — cross-session lock timing, not
 * something a mock can model. `isRetiredLinkageCandidateError`'s
 * classification of the resulting error (constraint-scoped, not
 * SQLSTATE-only) is unit-tested against hand-built doubles in
 * `tests/unit/jobs/legacy-linkage-resolve/job.test.ts`; this spec exists to
 * prove the classifier's assumed error shape — SQLSTATE `23503` with
 * `constraint_name` set to one of the two named FKs — is what a real delete
 * actually produces.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const SHAPE_FIXTURE_LIBRARY_ID = 7000;
const TITLE_PREFIX = 'BS#2594 Retired Candidate Probe';
const ROTATION_LEGACY_RELEASE_ID = 25940001;
const FLOWSHEET_LEGACY_RELEASE_ID = 25940002;

// Same lever as `legacy-linkage-lock-guard.spec.js`: below the default 1s
// `deadlock_timeout`, must match `LINKAGE_LOCK_TIMEOUT_MS` in job.ts.
const LOCK_TIMEOUT_MS = 750;
const STATEMENT_TIMEOUT_MS = 3000;
// How long to let `worker`'s UPDATE reach the FK check's blocking wait before
// `holder` commits. Generous relative to a same-box round trip; still well
// under LOCK_TIMEOUT_MS so the commit — not the lock timeout — is what
// unblocks the check.
const INTERLEAVE_DELAY_MS = 200;

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

  const cleanupProbes = async (sql) => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".rotation WHERE legacy_library_release_id = $1`, [
      ROTATION_LEGACY_RELEASE_ID,
    ]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE legacy_release_id = $1`, [FLOWSHEET_LEGACY_RELEASE_ID]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${TITLE_PREFIX}%`]);
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
        `INSERT INTO "${SCHEMA}".flowsheet (legacy_release_id, artist_name, track_title)
         VALUES ($1, $2, $3)`,
        [legacyReleaseId, `${TITLE_PREFIX} artist`, `${TITLE_PREFIX} track`]
      );
    }
    return libraryId;
  };

  beforeAll(async () => {
    holder = makeSql();
    worker = makeSql();
    await cleanupProbes(worker);
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

  afterEach(async () => {
    await cleanupProbes(worker);
  });

  /**
   * Runs `statement` under the same lock guard `runGuardedDrain` applies in
   * production, and starts a concurrent `DELETE` on `libraryId` via `holder`
   * that stays open (uncommitted) until `commitDeleteAfterMs`, so the FK
   * check `statement`'s UPDATE fires blocks on `holder`'s row lock and then
   * observes the row gone once `holder` commits.
   */
  const runAgainstRacingDelete = async (statement, libraryId) => {
    await holder.unsafe('BEGIN');
    await holder.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = $1`, [libraryId]);

    const workerPromise = (async () => {
      await worker.unsafe('BEGIN');
      await worker.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await worker.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      try {
        const rows = await worker.unsafe(statement);
        await worker.unsafe('ROLLBACK');
        return { rows, error: null };
      } catch (error) {
        await worker.unsafe('ROLLBACK').catch(() => {});
        return { rows: null, error };
      }
    })();

    await new Promise((r) => setTimeout(r, INTERLEAVE_DELAY_MS));
    await holder.unsafe('COMMIT');

    return workerPromise;
  };

  test('a concurrent delete mid-statement produces 23503 on rotation_album_id_library_id_fk, not a lock timeout', async () => {
    const libraryId = await seedProbe(worker, { legacyReleaseId: ROTATION_LEGACY_RELEASE_ID, table: 'rotation' });

    const { error } = await runAgainstRacingDelete(ROTATION_DRAIN_SQL, libraryId);

    expect(error).not.toBeNull();
    expect(error.code).toBe('23503');
    expect(error.constraint_name).toBe('rotation_album_id_library_id_fk');
  });

  test('a concurrent delete mid-statement produces 23503 on flowsheet_album_id_library_id_fk too', async () => {
    const libraryId = await seedProbe(worker, { legacyReleaseId: FLOWSHEET_LEGACY_RELEASE_ID, table: 'flowsheet' });

    const { error } = await runAgainstRacingDelete(FLOWSHEET_DRAIN_SQL, libraryId);

    expect(error).not.toBeNull();
    expect(error.code).toBe('23503');
    expect(error.constraint_name).toBe('flowsheet_album_id_library_id_fk');
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
    await worker.unsafe('ROLLBACK');

    expect(Number(rows[0].resolved)).toBeGreaterThanOrEqual(1);
    expect(linked[0].album_id).toBe(survivingLibraryId);
  });
});
