/**
 * Orchestration spine for the daily "no metadata match" digest, separated
 * from `job.ts`'s process entrypoint so `run()` can be unit-tested without
 * `job.ts`'s module-load `void main()` side effect.
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
 * `metadata_attempt_at`), and -- if there is at least one miss -- emails ONE
 * digest to `DIGEST_RECIPIENT_EMAIL` (`email.ts`): catalog/rotation-linked
 * misses in full, freeform misses aggregated by artist (`format.ts`).
 *
 * Watermark semantics (see `watermark.ts`): `runStart` is captured before the
 * query runs. The watermark advances to `runStart` on a successful send OR a
 * 0-row run (still no email, but the window shouldn't be re-scanned next
 * time). A send failure leaves it untouched so the next run retries the exact
 * same window. A disabled (`EMAIL_ENABLED=false`) observe-only run also
 * leaves it untouched, so a later real run still sees the misses. First run
 * (no `cronjob_runs` row) bounds the window to the last 24h rather than
 * dumping full history.
 *
 * Read-only against `flowsheet`: no INSERT/UPDATE/DELETE, no schema
 * migration.
 */
import { db } from '@wxyc/database';
import { MAX_DIGEST_ROWS, queryNoMatchRows } from './query.js';
import { buildDigestEmail } from './format.js';
import { resolveDigestRecipient, sendDigestEmail } from './email.js';
import { advanceWatermarkIfSuccessful, getLastRun, resolveWindowStart } from './watermark.js';
import { log, errorMessage } from './logger.js';

export const JOB_NAME = 'metadata-no-match-digest';

export const run = async (): Promise<void> => {
  const runStart = new Date();
  const lastRun = await getLastRun(JOB_NAME);
  const windowStart = resolveWindowStart(lastRun, runStart);

  log('info', 'query', 'scanning flowsheet for new enriched_no_match rows', {
    window_start: windowStart.toISOString(),
    first_run: lastRun === null,
  });

  const rows = await queryNoMatchRows(windowStart);
  const digest = buildDigestEmail(rows, {
    since: windowStart,
    runStart,
    truncated: rows.length >= MAX_DIGEST_ROWS,
  });

  if (!digest) {
    log('info', 'no_misses', 'no new enriched_no_match rows since last run; advancing watermark without sending', {
      window_start: windowStart.toISOString(),
    });
    await advanceWatermarkIfSuccessful(db, JOB_NAME, runStart, true);
    return;
  }

  let sent = false;
  let sendError: unknown;
  try {
    sent = await sendDigestEmail(resolveDigestRecipient(), digest);
  } catch (error) {
    sendError = error;
  }

  if (sendError !== undefined) {
    // Do NOT advance the watermark -- the next run re-queries and retries this
    // exact window. Sentry capture is left to main()'s single catch to avoid a
    // duplicate event; this structured log carries the row_count context.
    log('error', 'send_failed', 'digest email send failed; watermark not advanced, next run retries this window', {
      error_message: errorMessage(sendError),
      row_count: rows.length,
    });
    throw sendError instanceof Error ? sendError : new Error(errorMessage(sendError));
  }

  if (!sent) {
    // EMAIL_ENABLED=false: observe-only dry run. Log the preview and leave the
    // watermark untouched so a real (enabled) run still sees these rows.
    log('info', 'send_disabled', `email sending disabled; would have sent digest for ${rows.length} no-match row(s)`, {
      row_count: rows.length,
      subject: digest.subject,
      watermark_advanced: false,
    });
    return;
  }

  await advanceWatermarkIfSuccessful(db, JOB_NAME, runStart, true);
  log('info', 'sent', `digest email sent for ${rows.length} no-match row(s)`, {
    row_count: rows.length,
    watermark_advanced: true,
  });
};
