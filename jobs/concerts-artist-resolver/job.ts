/**
 * Entrypoint for jobs/concerts-artist-resolver (BS#1372; extended to a
 * four-step run by BS#1760, parent #1618, On Tour epic #1588).
 *
 * Daily cron (default `15 5 * * *` UTC), now four ordered steps in one
 * run — folding the support-act junction sync + resolve into this job
 * rather than a standalone cron gives a hard step-ordering guarantee two
 * crons scheduled minutes apart via deploy-base cannot:
 *
 *   1. **Sync** `concert_performers` (role='support') from
 *      `concerts.supporting_artists_raw` — idempotent UPSERT on
 *      `(concert_id, role, raw_name)`, array-shrink soft-tombstone,
 *      reappearance un-tombstone. See sync.ts / sync-db.ts.
 *   2. **Headliner resolve** — UNCHANGED from BS#1372. Resolves
 *      `concerts.headlining_artist_raw` to `concerts.headlining_artist_id`
 *      via the strict-then-alias local resolver using migration 0092's
 *      `normalize_artist_name(text)` function and the three functional
 *      indexes on `artists`, `artist_search_alias`, and the partial index
 *      on `concerts (id) WHERE headlining_artist_id IS NULL`. No LML
 *      round-trip.
 *   3. **Support resolve arm** — the same strict-then-alias
 *      `resolveArtistId` fn (reused verbatim), applied to unresolved
 *      `concert_performers` rows via a bespoke loop + junction writer.
 *      See support.ts / support-db.ts.
 *   4. **Recompute** `concerts.has_resolved_support` — a single
 *      set-based UPDATE, windowed recompute-from-truth over the active
 *      concert set. See recompute.ts.
 *
 * Idempotent throughout: step 1's UPSERT/tombstone predicates, step 2 and
 * 3's `*_id IS NULL` gates, and step 4's `IS DISTINCT FROM` guard are all
 * rerun-safe and race-safe against a parallel pod or a scraper write that
 * lands mid-run.
 *
 * Steps run strictly in sequence inside one try block: a fatal failure in
 * an earlier step (e.g. `loadCandidates` throwing on a lost DB
 * connection) aborts the remaining steps for this run rather than
 * attempting them against a known-bad connection — mirrors how
 * album-reviews-etl's link pass is allowed to fail the whole cron loudly
 * rather than being isolated. Per-row/per-concert failures WITHIN a step
 * never abort that step's own loop (each of runSync / runResolver /
 * runSupportResolver catches and counts per-item errors internally).
 *
 * Invocation:
 *   docker run --rm --env-file .env <image>
 *
 * Required env: DB_* (postgres connection).
 *
 * Optional env:
 *   SENTRY_DSN, SENTRY_RELEASE — observability.
 */

import { closeDatabaseConnection } from '@wxyc/database';

import { runResolver } from './orchestrate.js';
import { loadCandidates, resolveArtistId } from './query.js';
import { writeArtistId } from './writer.js';
import { runSync } from './sync.js';
import { loadSyncCandidates, applySyncDiff } from './sync-db.js';
import { runSupportResolver } from './support.js';
import { loadSupportCandidates, writeSupportArtistId } from './support-db.js';
import { recomputeHasResolvedSupport } from './recompute.js';
import { initLogger, log, captureError, captureCounter, closeLogger } from './logger.js';

const JOB_NAME = 'concerts-artist-resolver';

/**
 * Pull a usable error message off `unknown` so a `throw 'string'` /
 * `throw null` / a Symbol from upstream code doesn't crash the catch
 * block via `(error as Error).message`. The whole body is wrapped in a
 * try so even `e instanceof Error` (a Proxy with throwing
 * `Symbol.hasInstance`) or a throwing `.message` getter can't escape —
 * symmetric with `safeStringifyThrown` in error-sink.ts. Mirrors the
 * pattern in `jobs/rotation-artist-backfill/job.ts` (BS#1361) — once a
 * third caller appears, promote to `shared/database` or a shared
 * `jobs/` helper.
 */
const errorMessage = (e: unknown): string => {
  try {
    if (e instanceof Error) return e.message;
    return String(e);
  } catch {
    return '<unrepresentable error>';
  }
};

/** Mirror of `errorMessage` for the discriminator field. */
const errorName = (e: unknown): string => {
  try {
    if (e instanceof Error) return e.name;
    return typeof e;
  } catch {
    return '<unrepresentable error>';
  }
};

/**
 * Run a teardown step and log+swallow any throw so a failure in one
 * cleanup call doesn't skip the next. Without this, an exception out of
 * `closeDatabaseConnection` would prevent `closeLogger` from running —
 * Sentry events would stay buffered and the PG pool would leak through
 * to process exit. Pattern landed independently for BS#1361.
 *
 * Sets `process.exitCode = 1` on failure so a teardown error after an
 * otherwise-successful run doesn't masquerade as a clean exit —
 * monitoring keyed on exit code (the cron's primary success signal)
 * needs to see the failure even when the inner span resolved OK.
 */
const safeFinalize = async (step: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    log('error', step, `${JOB_NAME} cleanup step failed`, {
      error_message: errorMessage(e),
      error_name: errorName(e),
    });
    process.exitCode = 1;
  }
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    try {
      log('info', 'init', `${JOB_NAME} initialized`);

      // Step 1: sync concert_performers (role='support') from
      // supporting_artists_raw. Must run before step 3 so this same
      // cycle's newly-synced rows are visible to the support resolver.
      const { totals: syncTotals } = await runSync({
        loadCandidates: loadSyncCandidates,
        applyDiff: applySyncDiff,
        onError: (candidate, error) => {
          log('warn', 'sync_row_error', `sync failed for concert ${candidate.concert_id}`, {
            concert_id: candidate.concert_id,
            error_message: errorMessage(error),
            error_name: errorName(error),
          });
          captureError(error, 'sync_row_error', { concert_id: candidate.concert_id });
        },
      });

      log('info', 'sync_finished', `${JOB_NAME} sync done`, { ...syncTotals });

      // Step 2: headliner resolve — UNCHANGED from BS#1372.
      const { totals } = await runResolver({
        loadCandidates,
        resolve: resolveArtistId,
        write: writeArtistId,
        onError: (candidate, error) => {
          log('warn', 'row_error', `resolver row failed for concert ${candidate.id}`, {
            concert_id: candidate.id,
            error_message: errorMessage(error),
            error_name: errorName(error),
          });
          captureError(error, 'row_error', { concert_id: candidate.id });
        },
      });

      log('info', 'finished', `${JOB_NAME} done`, { ...totals });

      // Step 3: support resolve arm. Reuses resolveArtistId verbatim
      // (query.js) through the bespoke support.ts loop + support-db.ts
      // junction writer.
      const { totals: supportTotals } = await runSupportResolver({
        loadCandidates: loadSupportCandidates,
        resolve: resolveArtistId,
        write: writeSupportArtistId,
        onError: (candidate, error) => {
          log('warn', 'support_row_error', `support resolver failed for performer ${candidate.id}`, {
            performer_id: candidate.id,
            error_message: errorMessage(error),
            error_name: errorName(error),
          });
          captureError(error, 'support_row_error', { performer_id: candidate.id });
        },
      });

      log('info', 'support_finished', `${JOB_NAME} support resolve done`, { ...supportTotals });

      // Step 4: recompute has_resolved_support from truth over the
      // active window. Must run after step 3 so this cycle's fresh
      // support resolutions (and step 1's tombstones/untombstones) are
      // reflected.
      const recomputeOutcome = await recomputeHasResolvedSupport();

      log('info', 'recompute_finished', `${JOB_NAME} has_resolved_support recompute done`, { ...recomputeOutcome });
    } catch (error) {
      log('error', 'failed', `${JOB_NAME} failed`, {
        error_message: errorMessage(error),
        error_name: errorName(error),
      });
      captureError(error, 'failed');
      captureCounter(`${JOB_NAME}.failed`, 1);
      process.exitCode = 1;
    }
  } finally {
    await safeFinalize('teardown_db', closeDatabaseConnection);
    await safeFinalize('teardown_logger', closeLogger);
  }
};

/**
 * Top-level run guard. `void main()` would swallow a rejection from the
 * finally block as an unhandled promise rejection — Node 19+ exits
 * non-zero on default settings, Node 18 warns and continues; behavior
 * also drifts across Node majors. Catching here means the cron always
 * exits with a meaningful code regardless. Logger may already be closed
 * by this point, so we write directly to stderr.
 */
main().catch((error: unknown) => {
  try {
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        step: 'unhandled',
        message: `${JOB_NAME} unhandled top-level rejection`,
        error_message: errorMessage(error),
        error_name: errorName(error),
      }) + '\n'
    );
  } catch {
    /* even stderr is gone — there is nothing else we can do */
  }
  process.exitCode = 1;
});
