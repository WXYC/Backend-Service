import { sql } from 'drizzle-orm';
import * as Sentry from '@sentry/node';
import { db, library } from '@wxyc/database';
import WxycError from '../utils/error.js';

/**
 * Thrown by `assertLibraryArtistNamePopulated()` when `library.artist_name`
 * still has at least one NULL row. Carries a 503 status code so the
 * `errorHandler` middleware refuses catalog-search requests with a body that
 * points operators at the backfill job.
 */
export class LibraryArtistNameMissingError extends WxycError {
  constructor(public readonly nullCount: number) {
    super(
      `library.artist_name has ${nullCount} NULL row(s); catalog search is disabled. ` +
        `Run jobs/library-artist-name-backfill/ and restart the backend.`,
      503,
      'LibraryArtistNameMissingError'
    );
  }
}

let _assertionPromise: Promise<void> | null = null;

async function runCheck(): Promise<void> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM ${library} WHERE ${library.artist_name} IS NULL LIMIT 1`
  );
  const rows = result as unknown as Array<{ n: number | string | null }>;
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) {
    Sentry.captureMessage('library.artist_name backfill missing — refusing catalog search', {
      level: 'error',
      tags: { tool: 'library-search', step: 'startup-assertion' },
      extra: { count: n },
    });
    throw new LibraryArtistNameMissingError(n);
  }
}

/**
 * Boot-time precondition for catalog search: refuses to serve until
 * `library.artist_name` is fully populated. Called at the top of every
 * public catalog-search entry point in `library.service.ts`.
 *
 * Once `artist_name` is populated, it stays populated, so the result is
 * cached for the lifetime of the process. A `LibraryArtistNameMissingError`
 * is also cached — the operator response is "run the backfill, restart the
 * process" — but transient DB errors clear the cache so the next call retries.
 */
export async function assertLibraryArtistNamePopulated(): Promise<void> {
  if (_assertionPromise === null) {
    _assertionPromise = runCheck().catch((err) => {
      if (!(err instanceof LibraryArtistNameMissingError)) {
        _assertionPromise = null;
      }
      throw err;
    });
  }
  return _assertionPromise;
}

/**
 * Test-only: reset the cached assertion state. Production code must not call
 * this — once a process has decided to refuse search, it has to restart to
 * re-check.
 */
export function _resetLibraryArtistNameAssertionForTests(): void {
  _assertionPromise = null;
}
