/**
 * Daily "no metadata match" digest.
 *
 * When LML genuinely finds nothing for a playcut, the enrichment worker
 * (`apps/enrichment-worker`) durably stamps `flowsheet.metadata_status =
 * 'enriched_no_match'`. That outcome is deliberately suppressed from Sentry
 * (`SUPPRESSED_EMPTY_CAUSES` in the worker's handler) because routine
 * no-matches are expected on a freeform station and would be noise -- but
 * nobody was told when one happened. This job is the push: once daily, it
 * reads the `cronjob_runs` watermark for this job, queries `flowsheet` for
 * rows that became `enriched_no_match` since the last run (`query.ts`,
 * filtered/sorted on `updated_at` -- see that file for why never
 * `metadata_attempt_at`), and -- if there is at least one miss -- emails
 * ONE digest to `DIGEST_RECIPIENT_EMAIL` (`email.ts`): catalog/rotation-
 * linked misses in full, freeform misses aggregated by artist (`format.ts`).
 *
 * Watermark semantics (see `watermark.ts`): `runStart` is captured before
 * the query runs. The watermark advances to `runStart` on a successful
 * send OR a 0-row run (still no email, but the window shouldn't be
 * re-scanned next time); a send failure leaves it untouched so the next
 * run retries the exact same window. First run (no `cronjob_runs` row)
 * bounds the window to the last 24h rather than dumping full history.
 *
 * Read-only against `flowsheet`: no INSERT/UPDATE/DELETE, no schema
 * migration. No SIGTERM/SIGINT handling needed -- unlike the paged sweeps
 * this job's single query + single send complete well inside any
 * reasonable timeout.
 */
import { closeDatabaseConnection, db } from '@wxyc/database';
import { queryNoMatchRows } from './query.js';
import { buildDigestEmail } from './format.js';
import { resolveDigestRecipient, sendDigestEmail } from './email.js';
import { advanceWatermarkIfSuccessful, getLastRun, resolveWindowStart } from './watermark.js';
import { initLogger, log, captureError, closeLogger, errorMessage } from './logger.js';

const JOB_NAME = 'metadata-no-match-digest';

export const run = async (): Promise<void> => {
  const runStart = new Date();
  const lastRun = await getLastRun(JOB_NAME);
  const windowStart = resolveWindowStart(lastRun, runStart);

  log('info', 'query', 'scanning flowsheet for new enriched_no_match rows', {
    window_start: windowStart.toISOString(),
    first_run: lastRun === null,
  });

  const rows = await queryNoMatchRows(windowStart);
  const digest = buildDigestEmail(rows, { since: windowStart, runStart });

  if (!digest) {
    log('info', 'no_misses', 'no new enriched_no_match rows since last run; advancing watermark without sending', {
      window_start: windowStart.toISOString(),
    });
    await advanceWatermarkIfSuccessful(db, JOB_NAME, runStart, true);
    return;
  }

  let sendError: unknown;
  try {
    await sendDigestEmail(resolveDigestRecipient(), digest);
  } catch (error) {
    sendError = error;
  }

  const runSucceeded = sendError === undefined;
  const advanced = await advanceWatermarkIfSuccessful(db, JOB_NAME, runStart, runSucceeded);

  if (!runSucceeded) {
    log('error', 'send_failed', 'digest email send failed; watermark not advanced, next run retries this window', {
      error_message: errorMessage(sendError),
      row_count: rows.length,
    });
    captureError(sendError, 'send_failed', { row_count: rows.length });
    throw sendError instanceof Error ? sendError : new Error(errorMessage(sendError));
  }

  log('info', 'sent', `digest email sent for ${rows.length} no-match row(s)`, {
    row_count: rows.length,
    watermark_advanced: advanced,
  });
};

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    log('info', 'init', `${JOB_NAME} initialized`);
    await run();
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: errorMessage(error) });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

void main();
