import * as Sentry from '@sentry/node';
import { nyCalendarDate } from '@wxyc/database';

/**
 * The one reader of `REVIEW_GATE_CUTOVER_DATE` (epic #2791; see `docs/env-vars.md`).
 * `YYYY-MM-DD`, station time; unset means the gate is off. A set value that is not a
 * real date is reported (once per process) and treated as on: a gate wrongly on shows
 * up at once as 409s, a gate wrongly off lets releases in unreviewed unnoticed.
 */

/** Stands in for a malformed value: the gate is on today, and no stored date is on or before it. */
const MALFORMED = '0001-01-01';

let reported = false;

/** A real calendar date in `YYYY-MM-DD` shape (year 0001 or later), checked by round-trip so it never throws. */
const isRealDate = (raw: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number);
  if (y < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

/** `null` while unset; otherwise the cutover date, or `MALFORMED`. */
const cutover = (): string | null => {
  const raw = process.env.REVIEW_GATE_CUTOVER_DATE;
  if (raw === undefined || raw === '') return null;
  if (isRealDate(raw)) return raw;
  if (!reported) {
    reported = true;
    Sentry.captureException(
      new Error('REVIEW_GATE_CUTOVER_DATE is not a real YYYY-MM-DD date; treating the gate as on')
    );
  }
  return MALFORMED;
};

/** The cutover date for SQL comparisons (`null` while unset), reporting a malformed value. */
export const reviewGateCutoverDate = cutover;

/** Whether the gate is on at `now`: from the cutover date itself, in station time. */
export const isGateOn = (now: Date = new Date()): boolean => {
  const date = cutover();
  return date !== null && nyCalendarDate(now) >= date;
};

/**
 * Whether a stored date is on or before the cutover (any date while unset). A `date` column
 * (`rotation.add_date`) is compared as stored; a `timestamptz` instant is converted to its station calendar date.
 */
export const isOnOrBeforeCutover = (stored: string | Date): boolean => {
  const date = cutover();
  return date === null || (typeof stored === 'string' ? stored : nyCalendarDate(stored)) <= date;
};
