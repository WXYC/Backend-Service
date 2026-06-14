/**
 * Entry point for the rotation-artist-backfill job (BS#1381).
 *
 * Daily cron (default `30 4 * * *` UTC — between artist-search-alias-consumer
 * at `15 4` and flowsheet-metadata-backfill at `0 6`). One-tier batched loop:
 *
 *   for batch in chunk(active_rotation_identity_ids(), 50):
 *     POST /api/v1/cache/refresh-for-identities { identity_ids: batch }
 *
 * LML handles the per-source release-cache refresh AND the walk-to-artists
 * step (release.artists[*].artist_id → artist refresh) internally. The job's
 * value is that BS no longer needs to hold Discogs IDs to warm the cache —
 * `rotation.lml_identity_id` (BS#1380) is the stable handle, and LML maps
 * it to every per-source (source, external_id) pair it knows about. New
 * sources (MusicBrainz, Bandcamp, Spotify, Apple Music) light up
 * transparently as LML wires them, without a BS-side cron change.
 *
 * Run procedure:
 *   - Production: registered via the BS deploy-base machinery
 *     (`cron-schedule` field in package.json picked up by
 *     scripts/resolve-cron-schedule.sh).
 *   - Manual one-shot on EC2:
 *       docker run --rm --env-file .env <image> 2>&1 | tee log
 *   - DRY_RUN: set `DRY_RUN=true` to enumerate identity cardinality
 *     before any refresh calls fire.
 *
 * Resumable + idempotent — see orchestrate.ts header.
 */

import * as Sentry from '@sentry/node';
import { envInt } from '@wxyc/lml-client';

import { closeDatabaseConnection } from '@wxyc/database';

import { DeployGuardError, enforceDeployGuard } from './deploy-guard.js';
import { runBackfill } from './orchestrate.js';
import { loadActiveRotationIdentityIds } from './query.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'rotation-artist-backfill';

/**
 * Fail closed before any rows are scanned if the LML transport surface
 * is misconfigured. LML_API_KEY is required in staging/prod where
 * `LML_REQUIRE_AUTH` is on — without it every refresh call would
 * silently 401, the run would look like a transient outage in
 * dashboards, and the daily cron would re-run with the same fault
 * indefinitely. LOCAL_DEV=1 keeps the local-dev escape hatch the
 * README documents.
 */
const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
  if (!process.env.LML_API_KEY && process.env.LOCAL_DEV !== '1') {
    throw new Error(
      'LML_API_KEY is not configured; aborting before any rows are scanned. Set LOCAL_DEV=1 to override in dev / CI.'
    );
  }
};

/**
 * Accept `1`, `true`, `True`, `TRUE`. Conservative on purpose — common
 * mistakes like Python's `True` capitalization and shell-style yes
 * should not silently fall through to the false branch.
 */
const envBool = (name: string): boolean => {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
};

/**
 * Pull a usable error message off `unknown` so a `throw 'string'` or
 * `throw null` from upstream code doesn't crash the catch block via
 * `(error as Error).message`.
 *
 * For an AggregateError (the multi-task failure case from
 * runWithConcurrency), the wrapper message alone (`"3 tasks failed..."`)
 * loses the leaf failures from the JSON log line. Ops triaging through
 * container logs without Sentry access would otherwise see only the
 * count. Join the leaf messages so the log line is self-contained.
 */
const errorMessage = (e: unknown): string => {
  if (e instanceof AggregateError) {
    const leaves = e.errors.map((leaf: unknown) => (leaf instanceof Error ? leaf.message : String(leaf))).join('; ');
    return `${e.message} [${leaves}]`;
  }
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
};

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/**
 * Run `fn` and log+swallow any throw. Used for the two close calls in
 * the finally block so a failure in one doesn't prevent the other from
 * running and dropping a buffered Sentry event or leaving a PG pool open.
 */
const safeFinalize = async (step: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    log('error', step, `${JOB_NAME} cleanup step failed`, {
      error_message: errorMessage(e),
      error_name: errorName(e),
    });
  }
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  // The wrapping Sentry span MUST end before `closeLogger` runs — that
  // call invokes `Sentry.close(2000)`, which shuts down the transport.
  // If the close fires from inside the startSpan callback, the
  // wrapping span itself gets dropped by the now-closed transport.
  try {
    await Sentry.startSpan({ name: `${JOB_NAME}.run`, op: 'job.run' }, async () => {
      try {
        requireLmlConfigured();
        log('info', 'init', `${JOB_NAME} initialized`);

        const guard = await enforceDeployGuard();
        log('info', 'deploy_guard', 'LML deploy gate passed', {
          commit_sha: guard.commit_sha,
          reason: guard.reason,
        });

        const concurrency = envInt('BACKFILL_LML_MAX_CONCURRENT', 3);
        const dryRun = envBool('DRY_RUN');

        const result = await runBackfill({
          loadIdentityIds: loadActiveRotationIdentityIds,
          concurrency,
          dryRun,
        });

        log('info', 'done', `${JOB_NAME} completed`, {
          ...result.totals,
          dry_run: dryRun,
        });
      } catch (error) {
        const step = error instanceof DeployGuardError ? 'deploy_guard' : 'failed';
        log('error', step, `${JOB_NAME} failed`, {
          error_message: errorMessage(error),
          error_name: errorName(error),
        });
        captureError(error, step);
        // Mark the wrapping `${JOB_NAME}.run` span as failed so OTLP /
        // Sentry error-rate alerts keyed on `op:job.run` actually fire.
        // The catch swallows the throw (we set process.exitCode = 1 and
        // let the cron exit cleanly so safeFinalize still runs), which
        // would otherwise leave the parent span resolving OK and hide
        // the failure from dashboards. Codes: 0 = unset, 1 = OK, 2 = ERROR.
        Sentry.getActiveSpan()?.setStatus({ code: 2, message: step });
        process.exitCode = 1;
      }
    });
  } finally {
    await safeFinalize('teardown_db', closeDatabaseConnection);
    await safeFinalize('teardown_logger', closeLogger);
  }
};

/**
 * Top-level run guard. `void main()` would swallow a rejection from the
 * finally block (closeDatabaseConnection / closeLogger) as an unhandled
 * promise rejection. Catching here means the cron always exits with a
 * meaningful code instead of relying on Node's unhandledRejection
 * default behavior — which has changed between Node major versions.
 */
main().catch((error: unknown) => {
  // Logger may be closed by this point; write directly to stderr.
  process.stderr.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      step: 'unhandled',
      message: `${JOB_NAME} terminated with an unhandled error`,
      error_message: errorMessage(error),
      error_name: errorName(error),
    }) + '\n'
  );
  process.exitCode = 1;
});
