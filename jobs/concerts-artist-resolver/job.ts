/**
 * Entrypoint for jobs/concerts-artist-resolver (BS#1372).
 *
 * Daily cron (default `15 5 * * *` UTC). Resolves
 * `concerts.headlining_artist_raw` to `concerts.headlining_artist_id`
 * via the strict-then-alias local resolver using migration 0092's
 * `normalize_artist_name(text)` function and the three functional
 * indexes on `artists`, `artist_search_alias`, and the partial index on
 * `concerts (id) WHERE headlining_artist_id IS NULL`. No LML round-trip.
 *
 * Idempotent: the SELECT predicate is `headlining_artist_id IS NULL`
 * and the UPDATE's WHERE guard mirrors it — both rerun-safe and race-
 * safe against a parallel pod or a scraper write that lands mid-run.
 *
 * Run shape:
 *   - One pass over all eligible `concerts` rows.
 *   - Per-row strict-then-alias resolver (each arm is a separate SQL
 *     query — keeps the strict-wins rule explicit and lets Postgres
 *     short-circuit when strict hits).
 *   - Writes only on singleton match; ambiguous / unmatched / errored
 *     rows leave the FK NULL and increment dedicated counters.
 *
 * Invocation:
 *   docker run --rm --env-file .env <image>
 *
 * Required env: DB_* (postgres connection).
 *
 * Optional env:
 *   SENTRY_DSN, SENTRY_RELEASE, SENTRY_TRACES_SAMPLE_RATE — observability.
 */

import * as Sentry from '@sentry/node';

import { closeDatabaseConnection } from '@wxyc/database';

import { runResolver } from './orchestrate.js';
import { loadCandidates, resolveArtistId } from './query.js';
import { writeArtistId } from './writer.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'concerts-artist-resolver';

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    await Sentry.startSpan({ name: `${JOB_NAME}.run`, op: 'job.run' }, async () => {
      log('info', 'init', `${JOB_NAME} initialized`);

      const { totals } = await runResolver({
        loadCandidates,
        resolve: resolveArtistId,
        write: writeArtistId,
        onError: (candidate, error) => {
          const message = error instanceof Error ? error.message : String(error);
          log('warn', 'row_error', `resolver row failed for concert ${candidate.id}`, {
            concert_id: candidate.id,
            error_message: message,
          });
          captureError(error, 'row_error', { concert_id: candidate.id });
        },
      });

      log('info', 'finished', `${JOB_NAME} done`, { ...totals });

      // Surface run totals as a CHILD span whose numeric attributes are
      // set at creation time (per BS#1081 / memory
      // `feedback_sentry_attribute_typing_trap`: numeric values passed
      // via `setAttribute(name, number)` AFTER the span has already
      // started get indexed as strings, which breaks avg/p50/p95/sum
      // aggregation on Sentry dashboards).
      Sentry.startSpan(
        {
          name: `${JOB_NAME}.run.totals`,
          attributes: {
            'resolver.scanned': totals.scanned,
            'resolver.resolved': totals.resolved,
            'resolver.resolved_strict': totals.resolved_strict,
            'resolver.resolved_alias': totals.resolved_alias,
            'resolver.ambiguous': totals.ambiguous,
            'resolver.unmatched': totals.unmatched,
            'resolver.null_raw_skipped': totals.null_raw_skipped,
            'resolver.error': totals.error,
            'resolver.raced': totals.raced,
          },
        },
        () => {
          /* attributes set at creation; nothing else to do */
        }
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    // Cleanup runs OUTSIDE the `Sentry.startSpan` callback so the parent
    // `${JOB_NAME}.run` span's end event fires through a live transport.
    // `closeLogger` calls `Sentry.close(2000)`, which disables the SDK —
    // if we ran it in the span callback's finally, the parent span's
    // terminal event would land on an already-disabled client and the
    // whole transaction (including the .totals child span) would be
    // dropped silently.
    await closeDatabaseConnection();
    await closeLogger();
  }
};

void main();
