/**
 * America/New_York calendar helpers for the concert writers (migration 0112,
 * BS#1589). `concerts.starts_on` is defined as the *venue-local* calendar
 * date — all covered venues are in the Eastern time zone — so both writers
 * must agree on the same conversion:
 *
 *   - `jobs/venue-events-scraper` derives `starts_on` FROM an instant
 *     (`nyCalendarDate`), mirroring the migration's one-time backfill
 *     (`(starts_at AT TIME ZONE 'America/New_York')::date`).
 *   - `jobs/triangle-shows-etl` composes `starts_at`/`doors_at` from the
 *     source's date + local-time fields (`nyWallClockToUtc`).
 *
 * Built on Intl.DateTimeFormat (Node ships full IANA tz data) — no
 * dependency, DST handled by the platform.
 */

const NY_TIME_ZONE = 'America/New_York';

// en-CA formats dates as ISO YYYY-MM-DD directly.
const nyDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const nyOffsetFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TIME_ZONE,
  timeZoneName: 'longOffset',
});

/** The `YYYY-MM-DD` America/New_York calendar date of an instant. */
export const nyCalendarDate = (instant: Date): string => nyDateFormat.format(instant);

/** New York's UTC offset in milliseconds at the given instant (negative: -5h EST / -4h EDT). */
const nyOffsetMsAt = (instant: Date): number => {
  const part = nyOffsetFormat.formatToParts(instant).find((p) => p.type === 'timeZoneName');
  // e.g. "GMT-05:00" / "GMT-4" — Intl guarantees the GMT±H[:mm] shape for longOffset.
  const match = part?.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) {
    throw new Error(`nyOffsetMsAt: unparseable timeZoneName '${part?.value ?? '<missing>'}'`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? '0')) * 60_000;
};

/**
 * Interpret `isoDate` (`YYYY-MM-DD`) + `isoTime` (`HH:MM[:SS]`) as an
 * America/New_York wall-clock reading and return the UTC instant.
 *
 * Callers own the null branch — a date-only event's `starts_at` stays NULL
 * (never a fabricated time), so both arguments here are non-null.
 *
 * DST via the standard two-pass converge: guess the offset as if the wall
 * clock were UTC, then re-read the offset at the corrected instant. Times
 * inside the spring-forward gap resolve to the post-transition instant;
 * fall-back ambiguous times resolve to one consistent occurrence. Both
 * stay on the intended NY calendar date, which is what `starts_on` needs.
 */
export const nyWallClockToUtc = (isoDate: string, isoTime: string): Date => {
  const candidate = new Date(`${isoDate}T${isoTime.length === 5 ? `${isoTime}:00` : isoTime}Z`);
  if (Number.isNaN(candidate.getTime())) {
    throw new Error(`nyWallClockToUtc: unparseable date/time '${isoDate}' / '${isoTime}'`);
  }
  const firstPass = new Date(candidate.getTime() - nyOffsetMsAt(candidate));
  return new Date(candidate.getTime() - nyOffsetMsAt(firstPass));
};
