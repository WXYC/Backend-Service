/**
 * Pure rendering logic for the station-signup-review digest email. No DB, no
 * network -- takes the per-row `DowngradeDecision[]` this run produced (see
 * `downgrade.ts`) and plain `Date`s, and returns strings. Mirrors
 * `jobs/metadata-no-match-digest/format.ts`'s separation of pure formatting
 * from orchestration.
 *
 * The digest renders a decision the job already made, never a condition it
 * re-derives. An earlier version inferred "already downgraded — awaiting
 * review" from `days >= 30 && !downgradedThisRun`, which was wrong three
 * ways: it conflated a prior-run downgrade with a manual role change, and it
 * became an outright false statement whenever the kill switch was off
 * (overdue, disabled, still `dj`) or the on-air guard deferred (overdue,
 * deferred, still `dj`). Every status below now comes from `downgrade.ts`'s
 * own verdict for that row.
 */
import { DOWNGRADE_AFTER_DAYS } from './downgrade.js';
import type { DowngradeDecision } from './downgrade.js';
import type { PendingSignupRow } from './query.js';

export type { PendingSignupRow };

const PACIFIC_TIME_ZONE = 'America/Los_Angeles';

/** e.g. "2026-07-31" -- the Pacific *calendar* date for a UTC instant. */
export const formatPacificDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

/** Whole days between `selfSignupAt` and `now`, floored -- 0 on the day of signup. */
export const daysPending = (selfSignupAt: Date, now: Date): number =>
  Math.floor((now.getTime() - selfSignupAt.getTime()) / (24 * 60 * 60 * 1000));

export interface DigestEmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface StationSignupDigestContext {
  now: Date;
  /**
   * `true` when `STATION_SIGNUP_ALERT_EMAIL` is unset and the built-in
   * default address is carrying this digest. The fallback is deliberate --
   * an unset variable must not kill the safety-net digest during exactly the
   * weeks nobody is watching -- but it announces itself in the body so it
   * cannot quietly become the permanent configuration.
   */
  recipientFallbackInUse?: boolean;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rowLabel = (row: PendingSignupRow): string => row.djName ?? row.name;

export const RECIPIENT_FALLBACK_NOTICE = 'Recipient fallback in use; set STATION_SIGNUP_ALERT_EMAIL.';

/**
 * The status line for one decision, as plain prose plus whether it deserves
 * emphasis. Both renderings read the same single string, so the text and
 * HTML bodies cannot drift into saying different things -- the HTML branch
 * only escapes it and wraps the emphasized ones in `<strong>`.
 *
 * Exported for the unit tests, which assert one line per status rather than
 * grepping rendered bodies.
 */
export const statusText = (decision: DowngradeDecision, now: Date): { text: string; emphasize: boolean } => {
  const { row, status, downgradedAt } = decision;
  switch (status) {
    case 'downgraded':
      return { text: `downgraded dj -> member on ${formatPacificDate(downgradedAt ?? now)}`, emphasize: true };
    case 'already-downgraded':
      return {
        text: `downgraded dj -> member on ${formatPacificDate(downgradedAt ?? now)} — still awaiting review`,
        emphasize: false,
      };
    case 'deferred-on-air':
      return {
        text:
          decision.deferReason === 'guard-error'
            ? 'overdue — downgrade deferred: could not check whether this DJ is on air'
            : 'overdue — downgrade deferred: on air with an open show',
        emphasize: false,
      };
    case 'downgrade-disabled':
      return {
        text: 'overdue — downgrade disabled (STATION_SIGNUP_DOWNGRADE_ENABLED is not "true")',
        emphasize: false,
      };
    case 'already-member':
      return { text: 'overdue — already not a dj; nothing to downgrade', emphasize: false };
    case 'pending':
    default:
      return {
        text: `${DOWNGRADE_AFTER_DAYS - daysPending(row.selfSignupAt, now)} day(s) until auto-downgrade`,
        emphasize: false,
      };
  }
};

/**
 * Builds the digest, or returns `null` when nothing is pending -- the
 * caller (`orchestrate.ts`) treats `null` as "send nothing", per the plan's
 * "digest sends only when something is pending" acceptance criterion.
 *
 * `decisions` covers the WHOLE pending cohort, one entry per row, so the
 * count in the subject is `decisions.length`.
 */
export const buildStationSignupDigestEmail = (
  decisions: DowngradeDecision[],
  context: StationSignupDigestContext
): DigestEmailContent | null => {
  if (decisions.length === 0) return null;

  const { now, recipientFallbackInUse = false } = context;
  const dateLabel = formatPacificDate(now);

  const sorted = [...decisions].sort((a, b) => a.row.selfSignupAt.getTime() - b.row.selfSignupAt.getTime());
  const downgradingCount = sorted.filter((d) => d.status === 'downgraded').length;

  const subject = `WXYC station signup review: ${decisions.length} pending${
    downgradingCount > 0 ? `, ${downgradingCount} downgrading` : ''
  } — ${dateLabel}`;

  const textLines = sorted.map((decision) => {
    const days = daysPending(decision.row.selfSignupAt, now);
    return `- ${rowLabel(decision.row)} <${decision.row.email}> — pending ${days} day(s) (${
      statusText(decision, now).text
    })`;
  });

  const text = [
    `${decisions.length} station signup account(s) pending manager review as of ${dateLabel}.`,
    ...(recipientFallbackInUse ? ['', RECIPIENT_FALLBACK_NOTICE] : []),
    '',
    ...textLines,
  ].join('\n');

  const htmlRows = sorted
    .map((decision) => {
      const days = daysPending(decision.row.selfSignupAt, now);
      const { text: statusLine, emphasize } = statusText(decision, now);
      const status = emphasize ? `<strong>${escapeHtml(statusLine)}</strong>` : escapeHtml(statusLine);
      return `<li>${escapeHtml(rowLabel(decision.row))} &lt;${escapeHtml(
        decision.row.email
      )}&gt; — pending ${days} day(s) (${status})</li>`;
    })
    .join('');

  const fallbackHtml = recipientFallbackInUse ? `<p><em>${RECIPIENT_FALLBACK_NOTICE}</em></p>` : '';
  const html = `<p>${decisions.length} station signup account(s) pending manager review as of ${dateLabel}.</p>${fallbackHtml}<ul>${htmlRows}</ul>`;

  return { subject, html, text };
};
