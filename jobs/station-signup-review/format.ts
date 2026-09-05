/**
 * Pure rendering logic for the station-signup-review digest email. No DB, no
 * network -- takes `PendingSignupRow[]` (see `query.ts`) and plain `Date`s
 * and returns strings. Mirrors `jobs/metadata-no-match-digest/format.ts`'s
 * separation of pure formatting from orchestration.
 */
import { DOWNGRADE_AFTER_DAYS } from './downgrade.js';
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
  /** Accounts this run's downgrade pass actually flipped dj -> member. */
  downgraded: PendingSignupRow[];
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rowLabel = (row: PendingSignupRow): string => row.djName ?? row.name;

/**
 * Builds the digest, or returns `null` when nothing is pending -- the
 * caller (`orchestrate.ts`) treats `null` as "send nothing", per the plan's
 * "digest sends only when something is pending" acceptance criterion.
 *
 * Rows already downgraded this run are called out separately from rows
 * still within the 30-day window, so a reviewer sees at a glance which
 * accounts need attention today.
 */
export const buildStationSignupDigestEmail = (
  pending: PendingSignupRow[],
  context: StationSignupDigestContext
): DigestEmailContent | null => {
  if (pending.length === 0) return null;

  const { now, downgraded } = context;
  const downgradedIds = new Set(downgraded.map((row) => row.userId));
  const dateLabel = formatPacificDate(now);

  const sorted = [...pending].sort((a, b) => a.selfSignupAt.getTime() - b.selfSignupAt.getTime());

  const subject = `WXYC station signup review: ${pending.length} pending${
    downgraded.length > 0 ? `, ${downgraded.length} downgraded` : ''
  } — ${dateLabel}`;

  const textLines = sorted.map((row) => {
    const days = daysPending(row.selfSignupAt, now);
    const status = downgradedIds.has(row.userId)
      ? 'DOWNGRADED dj -> member today'
      : `${DOWNGRADE_AFTER_DAYS - days} day(s) until auto-downgrade`;
    return `- ${rowLabel(row)} <${row.email}> — pending ${days} day(s) (${status})`;
  });

  const text = [
    `${pending.length} station signup account(s) pending manager review as of ${dateLabel}.`,
    '',
    ...textLines,
  ].join('\n');

  const htmlRows = sorted
    .map((row) => {
      const days = daysPending(row.selfSignupAt, now);
      const isDowngraded = downgradedIds.has(row.userId);
      const status = isDowngraded
        ? '<strong>downgraded dj -&gt; member today</strong>'
        : `${DOWNGRADE_AFTER_DAYS - days} day(s) until auto-downgrade`;
      return `<li>${escapeHtml(rowLabel(row))} &lt;${escapeHtml(row.email)}&gt; — pending ${days} day(s) (${status})</li>`;
    })
    .join('');

  const html = `<p>${pending.length} station signup account(s) pending manager review as of ${dateLabel}.</p><ul>${htmlRows}</ul>`;

  return { subject, html, text };
};
