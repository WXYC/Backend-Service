import { sql } from 'drizzle-orm';
import * as Sentry from '@sentry/node';
import { db, library } from '@wxyc/database';

/**
 * Soft data-quality check for the denormalized `library.artist_name` column.
 *
 * Originally a hard precondition that 503'd catalog search whenever any row
 * carried NULL `artist_name`. That fired in prod 2026-04-30: a single ETL row
 * (Oneohtrix Point Never, "Tranquilizer", added 2026-04-28) was inserted by
 * `jobs/library-etl/job.ts` without `artist_name` set, and the next backend
 * restart cached a process-wide 503 — DJs locked out of the flowsheet for the
 * lifetime of the box.
 *
 * The denormalization is non-essential at the read path: search results
 * project `artists.artist_name` from the JOIN, and trigram predicates that
 * touch `library.artist_name` can't match a NULL via `%`, so degraded rows
 * silently drop out of search instead of poisoning it. The remaining role of
 * this check is observability — one Sentry warning per process when the
 * column is degraded, so the leak path is visible without taking the station
 * down.
 *
 * The result is memoized so the warning fires at most once per process and
 * the check stays off the per-search hot path after the first call.
 * Transient DB errors clear the cache so the next call retries.
 */

let _checkPromise: Promise<void> | null = null;

async function runCheck(): Promise<void> {
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

/**
 * Run the soft data-quality check exactly once per process. Returns void on
 * both healthy and degraded states; consumers must not branch on the result.
 * Callable from any catalog-search entry point as a fire-and-observe hook.
 */
export async function checkLibraryArtistNameHealth(): Promise<void> {
  if (_checkPromise === null) {
    _checkPromise = runCheck().catch((err) => {
      _checkPromise = null;
      throw err;
    });
  }
  return _checkPromise;
}

/**
 * Test-only: reset the cached check state so the next call re-queries.
 */
export function _resetLibraryArtistNameHealthCheckForTests(): void {
  _checkPromise = null;
}
