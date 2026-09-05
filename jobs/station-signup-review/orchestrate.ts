/**
 * Orchestration spine for the daily station-signup review (BS#2364), split
 * from `job.ts`'s process entrypoint so `run()` can be unit-tested without
 * the module-load `void main()` side effect (mirrors
 * `jobs/metadata-no-match-digest/orchestrate.ts`).
 *
 * Two things happen every run, both against the same pending cohort
 * (`self_signup_at IS NOT NULL AND self_signup_reviewed_at IS NULL`,
 * `query.ts`):
 *
 *   1. Downgrade -- any account pending for more than
 *      `DOWNGRADE_AFTER_DAYS` (30) drops `auth_member.role` from `dj` to
 *      `member` (`downgrade.ts`). Runs BEFORE the digest is built so the
 *      digest can name which accounts were downgraded today, rather than
 *      the digest and the downgrade independently re-deriving the same
 *      30-day cutoff and risking drift between them.
 *   2. Digest -- while ANY account is pending, email a summary to
 *      `STATION_SIGNUP_ALERT_EMAIL` (`email.ts`) naming every pending
 *      account, its days-pending, and (if applicable) that it was just
 *      downgraded. Zero pending accounts sends nothing.
 *
 * Unlike `metadata-no-match-digest`, there is no watermark: the digest is a
 * point-in-time snapshot of "what's pending right now", re-sent daily for
 * as long as anything is pending, not a "what's new since last time" feed.
 * A transient send failure is simply retried in full on the next daily run
 * -- there is no partial-window state to reconcile.
 */
import { db } from '@wxyc/database';
import { downgradeOverdueAccounts } from './downgrade.js';
import { buildStationSignupDigestEmail } from './format.js';
import { queryPendingSelfSignups } from './query.js';
import { resolveStationSignupRecipient, sendStationSignupDigestEmail } from './email.js';
import { log, errorMessage } from './logger.js';

export const JOB_NAME = 'station-signup-review';

export const run = async (): Promise<void> => {
  const now = new Date();
  const pending = await queryPendingSelfSignups();

  log('info', 'query', 'queried self-signup accounts pending review', { pending_count: pending.length });

  if (pending.length === 0) {
    log('info', 'no_pending', 'no self-signup accounts pending review; nothing to downgrade or send');
    return;
  }

  const downgraded = await downgradeOverdueAccounts(db, pending, now);
  if (downgraded.length > 0) {
    log('info', 'downgraded', `downgraded ${downgraded.length} account(s) from dj to member (30+ days pending)`, {
      user_ids: downgraded.map((row) => row.userId),
    });
  }

  const digest = buildStationSignupDigestEmail(pending, { now, downgraded });
  if (!digest) {
    // Unreachable given the pending.length === 0 early return above, but kept
    // as the explicit contract: buildStationSignupDigestEmail is the single
    // source of truth for "should we send anything".
    return;
  }

  let sent = false;
  let sendError: unknown;
  try {
    sent = await sendStationSignupDigestEmail(resolveStationSignupRecipient(), digest);
  } catch (error) {
    sendError = error;
  }

  if (sendError !== undefined) {
    // Sentry capture is left to main()'s single catch to avoid a duplicate
    // event; this structured log carries the pending-count context.
    log('error', 'send_failed', 'station signup digest send failed', {
      error_message: errorMessage(sendError),
      pending_count: pending.length,
    });
    throw sendError instanceof Error ? sendError : new Error(errorMessage(sendError));
  }

  if (!sent) {
    log(
      'info',
      'send_disabled',
      `email sending disabled; would have sent digest for ${pending.length} pending account(s)`,
      {
        pending_count: pending.length,
        subject: digest.subject,
      }
    );
    return;
  }

  log('info', 'sent', `station signup digest sent for ${pending.length} pending account(s)`, {
    pending_count: pending.length,
    downgraded_count: downgraded.length,
  });
};
