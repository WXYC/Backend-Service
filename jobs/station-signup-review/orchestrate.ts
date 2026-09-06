/**
 * Orchestration spine for the daily station-signup review (BS#2364), split
 * from `job.ts`'s process entrypoint so `run()` can be unit-tested without
 * the module-load `void main()` side effect (mirrors
 * `jobs/metadata-no-match-digest/orchestrate.ts`).
 *
 * Four phases every run, all against the same pending cohort
 * (`self_signup_at IS NOT NULL AND self_signup_reviewed_at IS NULL`,
 * `query.ts`):
 *
 *   1. **Query** — the pending cohort.
 *   2. **Plan** (`downgrade.ts`'s `planDowngrades`) — decide, per account and
 *      without writing anything, what happens today: downgrade, already
 *      downgraded by a prior run, deferred because the DJ is on air, blocked
 *      by the kill switch, not a `dj` any more, or still inside the 30-day
 *      window.
 *   3. **Notify** — while ANY account is pending, email the digest to
 *      `STATION_SIGNUP_ALERT_EMAIL` (`email.ts`) naming every pending account
 *      with the decision from phase 2, including the accounts about to be
 *      downgraded today.
 *   4. **Apply** (`applyDowngrades`) — perform the writes.
 *
 * ## Notify-first, but the write is NOT gated on the send
 *
 * The digest goes out before the writes so it can never be a claim about a
 * privilege change the operator was not told about first. It is deliberately
 * NOT a precondition of them.
 *
 * Gating the write on a successful send would couple the backstop to the very
 * channel the backstop exists to back up: an unset `SES_FROM_EMAIL`, an
 * exhausted 200/month SES quota, or an SES outage would mean nobody is ever
 * downgraded, silently, and the failure looks exactly like "nothing was
 * overdue". Because the digest is level-triggered — the same account
 * reappears in it every single day until a human reviews it — a failed send
 * costs one day of awareness and nothing else. That asymmetry is the whole
 * argument.
 *
 * A send failure still exits the process non-zero (Sentry, and the cron's own
 * alerting) after the writes have been attempted.
 *
 * ## No watermark
 *
 * Unlike `metadata-no-match-digest`, the digest is a point-in-time snapshot
 * of "what's pending right now", re-sent daily for as long as anything is
 * pending, not a "what's new since last time" feed. There is no partial-window
 * state to reconcile.
 */
import { db } from '@wxyc/database';
import { applyDowngrades, isDowngradeEnabled, planDowngrades } from './downgrade.js';
import { buildStationSignupDigestEmail } from './format.js';
import { queryPendingSelfSignups } from './query.js';
import { resolveStationSignupRecipient, sendStationSignupDigestEmail } from './email.js';
import { log, errorMessage } from './logger.js';

export const JOB_NAME = 'station-signup-review';

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(errorMessage(value)));

export const run = async (): Promise<void> => {
  const now = new Date();
  const pending = await queryPendingSelfSignups();

  log('info', 'query', 'queried self-signup accounts pending review', { pending_count: pending.length });

  if (pending.length === 0) {
    log('info', 'no_pending', 'no self-signup accounts pending review; nothing to downgrade or send');
    return;
  }

  const downgradeEnabled = isDowngradeEnabled();
  const decisions = await planDowngrades(db, pending, now);
  const planned = decisions.filter((decision) => decision.status === 'downgraded');

  log('info', 'planned', `planned ${planned.length} downgrade(s) of ${pending.length} pending account(s)`, {
    pending_count: pending.length,
    planned_downgrade_count: planned.length,
    downgrade_enabled: downgradeEnabled,
    status_counts: decisions.reduce<Record<string, number>>((counts, decision) => {
      counts[decision.status] = (counts[decision.status] ?? 0) + 1;
      return counts;
    }, {}),
    deferred_user_ids: decisions
      .filter((decision) => decision.status === 'deferred-on-air')
      .map((decision) => decision.row.userId),
  });

  const recipient = resolveStationSignupRecipient();
  if (recipient.usedFallback) {
    log('warn', 'recipient_fallback', 'STATION_SIGNUP_ALERT_EMAIL is unset; falling back to the built-in default', {
      recipient: recipient.address,
    });
  }

  const digest = buildStationSignupDigestEmail(decisions, { now, recipientFallbackInUse: recipient.usedFallback });

  let sent = false;
  let sendError: unknown;
  if (digest) {
    try {
      sent = await sendStationSignupDigestEmail(recipient.address, digest);
    } catch (error) {
      sendError = error;
    }

    if (sendError !== undefined) {
      // Sentry capture is left to main()'s single catch to avoid a duplicate
      // event; this structured log carries the pending-count context. The
      // downgrade writes below still run -- see the header.
      log('error', 'send_failed', 'station signup digest send failed; performing downgrades anyway', {
        error_message: errorMessage(sendError),
        pending_count: pending.length,
        planned_downgrade_count: planned.length,
      });
    } else if (!sent) {
      log(
        'info',
        'send_disabled',
        `email sending disabled; would have sent digest for ${pending.length} pending account(s)`,
        { pending_count: pending.length, subject: digest.subject }
      );
    } else {
      log('info', 'sent', `station signup digest sent for ${pending.length} pending account(s)`, {
        pending_count: pending.length,
        planned_downgrade_count: planned.length,
      });
    }
  }

  let applyError: unknown;
  try {
    const applied = await applyDowngrades(db, decisions, now);

    if (applied.downgraded.length > 0) {
      log('info', 'downgraded', `downgraded ${applied.downgraded.length} account(s) from dj to member`, {
        user_ids: applied.downgraded.map((row) => row.userId),
      });
    }
    if (applied.raced.length > 0) {
      // The account's state moved between the plan and the write: it left
      // `dj`, or a manager reviewed it, or a competing run downgraded it
      // first. Nothing was written and no marker was stamped, so the next run
      // re-decides from scratch; the digest already sent is one line stale for
      // one day. Not a failure -- the run still exits 0 for this.
      log('warn', 'downgrade_raced', 'planned downgrade aborted; account state changed between plan and apply', {
        user_ids: applied.raced.map((row) => row.userId),
      });
    }
    if (applied.failed.length > 0) {
      for (const failure of applied.failed) {
        log('error', 'downgrade_failed', 'downgrade write failed for one account', {
          user_id: failure.row.userId,
          error_message: errorMessage(failure.error),
        });
      }
      applyError = applied.failed[0].error;
    }
  } catch (error) {
    log('error', 'downgrade_failed', 'downgrade pass failed', { error_message: errorMessage(error) });
    applyError = error;
  }

  // Both failure modes are already logged above; whichever is rethrown drives
  // the non-zero exit and the single Sentry event in job.ts's main(). The send
  // failure wins because it is the one that means a human was not told.
  if (sendError !== undefined) throw asError(sendError);
  if (applyError !== undefined) throw asError(applyError);
};
