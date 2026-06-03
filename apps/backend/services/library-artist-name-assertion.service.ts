import { sql } from 'drizzle-orm';
import * as Sentry from '@sentry/node';
import { db, library, artists } from '@wxyc/database';

/**
 * Soft data-quality checks for the denormalized `library.artist_name` column.
 *
 * Two independent observability probes share this module:
 *
 *   1. NULL check (`checkLibraryArtistNameNull`) — was the original 2026-04-30
 *      precondition that 503'd catalog search whenever any row carried NULL
 *      `artist_name`. A single ETL row (Oneohtrix Point Never, "Tranquilizer",
 *      added 2026-04-28) was inserted by `jobs/library-etl/job.ts` without
 *      `artist_name` set, and the next backend restart cached a process-wide
 *      503 — DJs locked out of the flowsheet for the lifetime of the box. The
 *      precondition was downgraded to a soft warning; trigram and tsvector
 *      predicates can't match a NULL with `%` or `@@`, so degraded rows fall
 *      out of search organically.
 *
 *   2. Drift check (`checkLibraryArtistNameDrift`, BS#1092) — detects value
 *      drift between `library.artist_name` (denorm, what trigram search reads)
 *      and `artists.artist_name` (canonical, what the catalog list view
 *      projects through `library_artist_view`'s INNER JOIN). Migration 0060's
 *      cascade trigger keeps them in sync on `UPDATE OF artist_name ON artists`,
 *      but ad-hoc admin SQL or future write paths (logical replication, a
 *      future admin UI touching `artists` directly) can bypass it. The latent
 *      symptom is invisible: the catalog list shows the new name; typing it
 *      into search returns nothing. The drift check surfaces a Sentry warning
 *      with a sampled set of offending `library_id`s so the leak path becomes
 *      visible before it reaches a DJ.
 *
 * Both checks are memoized so each fires at most once per process and stays
 * off the per-search hot path after the first call. Transient DB errors clear
 * the cache so the next call retries. Neither check ever throws to the
 * consumer — search continues to serve under any degraded state.
 */

let _nullCheckPromise: Promise<void> | null = null;
let _driftCheckPromise: Promise<void> | null = null;

const DRIFT_SAMPLE_SIZE = 10;

async function runNullCheck(): Promise<void> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM ${library} WHERE ${library.artist_name} IS NULL LIMIT 1`
  );
  const rows = result as unknown as Array<{ n: number | string | null }>;
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) {
    Sentry.captureMessage(`library.artist_name has ${n} NULL row(s) — denormalization is degraded`, {
      level: 'warning',
      tags: { tool: 'library-search', step: 'health-check' },
      extra: { count: n },
    });
    console.warn(
      `[library] library.artist_name has ${n} NULL row(s); search results omit those rows. ` +
        `Run jobs/library-artist-name-backfill/ to repair.`
    );
  }
}

async function runDriftCheck(): Promise<void> {
  // IS DISTINCT FROM treats NULLs symmetrically: a NULL `library.artist_name`
  // against a non-NULL `artists.artist_name` counts as drift. The NULL check
  // above already surfaces the NULL case under a different tag/step; both
  // surfacing it is intentional — different leak paths, same row.
  const result = await db.execute(
    sql`SELECT count(*)::int AS n,
               (SELECT array_agg(l2.id) FROM (
                  SELECT l.id FROM ${library} l
                  JOIN ${artists} a ON a.id = l.artist_id
                  WHERE l.artist_name IS DISTINCT FROM a.artist_name
                  ORDER BY l.id
                  LIMIT ${DRIFT_SAMPLE_SIZE}
                ) l2) AS sample_ids
        FROM ${library} l
        JOIN ${artists} a ON a.id = l.artist_id
        WHERE l.artist_name IS DISTINCT FROM a.artist_name`
  );
  const rows = result as unknown as Array<{
    n: number | string | null;
    sample_ids: Array<number | string> | null;
  }>;
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) {
    const sampleIds = (rows[0]?.sample_ids ?? []).map((id) => Number(id));
    Sentry.captureMessage(
      `library.artist_name has ${n} row(s) drift from artists.artist_name — denormalization is stale`,
      {
        level: 'warning',
        tags: { tool: 'library-search', step: 'drift-check' },
        extra: { count: n, sample_library_ids: sampleIds },
      }
    );
    console.warn(
      `[library] library.artist_name drift detected on ${n} row(s); ` +
        `catalog list shows the joined value but trigram search returns nothing. ` +
        `Sample library_ids: ${sampleIds.join(', ') || '(none)'}.`
    );
  }
}

/**
 * Drift probe (BS#1092). Counts rows where `library.artist_name` has drifted
 * away from `artists.artist_name` and emits a Sentry warning with a sampled
 * set of `library_id`s when drift > 0. Memoized; fires at most once per
 * process. Resolves on both healthy and degraded states.
 */
export async function checkLibraryArtistNameDrift(): Promise<void> {
  if (_driftCheckPromise === null) {
    _driftCheckPromise = runDriftCheck().catch((err) => {
      _driftCheckPromise = null;
      throw err;
    });
  }
  return _driftCheckPromise;
}

/**
 * Run the soft data-quality assertion sweep (NULL check + drift check)
 * exactly once per process per check. Returns void on both healthy and
 * degraded states; consumers must not branch on the result. Callable from
 * any catalog-search entry point as a fire-and-observe hook.
 */
export async function checkLibraryArtistNameHealth(): Promise<void> {
  if (_nullCheckPromise === null) {
    _nullCheckPromise = runNullCheck().catch((err) => {
      _nullCheckPromise = null;
      throw err;
    });
  }
  // Fan out — both checks run, both memoize independently. The drift check
  // is cheap (single indexed JOIN, count) and doesn't block readiness; the
  // caller awaits both because each check's failure mode is its own probe.
  await Promise.all([_nullCheckPromise, checkLibraryArtistNameDrift()]);
}

/**
 * Test-only: reset the cached NULL-check state so the next call re-queries.
 */
export function _resetLibraryArtistNameHealthCheckForTests(): void {
  _nullCheckPromise = null;
}

/**
 * Test-only: reset the cached drift-check state so the next call re-queries.
 */
export function _resetLibraryArtistNameDriftCheckForTests(): void {
  _driftCheckPromise = null;
}
