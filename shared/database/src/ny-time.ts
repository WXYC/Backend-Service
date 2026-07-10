/**
 * America/New_York calendar helpers for the concert writers (migration 0112,
 * BS#1589). `concerts.starts_on` is defined as the *venue-local* calendar
 * date — all covered venues are in the Eastern time zone — so both writers
 * must agree on the same conversion:
 *
 *   - `jobs/venue-events-scraper` derives `starts_on` FROM an instant
 *     (`nyCalendarDate`), mirroring migration 0112's backfill and the
 *     `concerts_derive_starts_on` trigger expression
 *     (`(starts_at AT TIME ZONE 'America/New_York')::date`).
 *   - `jobs/triangle-shows-etl` composes `starts_at`/`doors_at` from the
 *     source's date + local-time fields (`nyWallClockToUtc`).
 *
 * Built on Intl.DateTimeFormat (Node ships full IANA tz data) — no
 * dependency, DST handled by the platform.
 *
 * See also: `jobs/flowsheet-etl/transform.ts` (`easternOffsetAt` +
 * `parseMySQLDatetime`) carries an older sibling of the same two-pass NY
 * offset converge for tubafrenzy MySQL datetimes. A DST- or Intl-parsing
 * fix here almost certainly applies there too; consolidation onto this
 * module is a known follow-up — until then, patch both.
 */

/** The station's home time zone. Exported so consumers reference this
 *  constant instead of re-hardcoding the literal (it already appears in
 *  flowsheet.service.ts and flowsheet-etl). */
export const NY_TIME_ZONE = 'America/New_York';

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

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `YYYY-MM-DD` America/New_York calendar date of an instant.
 *
 * The output shape is validated: on a Node built without full ICU, Intl
 * silently falls back to locale data that formats en-CA as `MM/DD/YYYY`,
 * which would otherwise flow into the NOT NULL `date` column unnoticed —
 * fail fast here instead.
 */
export const nyCalendarDate = (instant: Date): string => {
  if (Number.isNaN(instant.getTime())) {
    // Fail with an attributed message instead of Intl's bare
    // 'RangeError: Invalid time value' pointing into formatter internals.
    throw new Error('nyCalendarDate: received an Invalid Date');
  }
  const formatted = nyDateFormat.format(instant);
  if (!ISO_DATE_SHAPE.test(formatted)) {
    throw new Error(
      `nyCalendarDate: Intl 'en-CA' produced '${formatted}', not YYYY-MM-DD — is this Node built with full-icu?`
    );
  }
  return formatted;
};

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

// HH:MM or HH:MM:SS, hour optionally unpadded (some feeds emit '9:30').
// Fractional seconds are accepted and TRUNCATED (never rounded up into
// the next second): Pydantic serializes Python `time` via isoformat(),
// which emits microseconds whenever they're nonzero — triangle-shows'
// Squarespace scraper concretely produces them (datetime.fromtimestamp
// of a millisecond timestamp). Rejecting the shape would permanently
// map_error those venues' events; sub-second precision carries no
// signal for a concert start time.
const TIME_SHAPE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;

/**
 * Interpret `isoDate` (`YYYY-MM-DD`) + `time` (`HH:MM[:SS]`, hour may be
 * unpadded) as an America/New_York wall-clock reading and return the UTC
 * instant.
 *
 * Callers own the null branch — a date-only event's `starts_at` stays NULL
 * (never a fabricated time), so both arguments here are non-null.
 *
 * DST policy (matches Temporal/java.time 'compatible'): a wall time inside
 * the spring-forward gap resolves FORWARD to the post-transition instant
 * (02:30 EST doesn't exist → 03:30 EDT); a fall-back ambiguous time
 * resolves to its first (earlier, EDT) occurrence. Implementation: probe
 * the NY offset treating the wall clock as UTC, re-probe at the corrected
 * instant; when the two probes disagree AND applying the second still
 * doesn't produce a self-consistent reading (the gap), keep the first
 * probe's result — which is the forward resolution.
 */
export const nyWallClockToUtc = (isoDate: string, time: string): Date => {
  const timeMatch = time.match(TIME_SHAPE);
  if (!ISO_DATE_SHAPE.test(isoDate) || !timeMatch) {
    throw new Error(`nyWallClockToUtc: unparseable date/time '${isoDate}' / '${time}' (want YYYY-MM-DD + HH:MM[:SS])`);
  }
  if (Number(timeMatch[1]) > 23) {
    // Reject explicitly: ECMA-262 quietly accepts T24:00 as next-day
    // midnight, which would window the event one calendar day late with
    // no error anywhere. A source meaning end-of-day midnight must say
    // which day it means ('00:00' on the next date).
    throw new Error(`nyWallClockToUtc: hour out of range in '${time}' (want 00-23; T24:00 is ambiguous about the day)`);
  }
  const normalizedTime = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}:${timeMatch[3] ?? '00'}`;
  const candidate = new Date(`${isoDate}T${normalizedTime}Z`);
  if (Number.isNaN(candidate.getTime())) {
    throw new Error(`nyWallClockToUtc: invalid date/time '${isoDate}' / '${time}'`);
  }

  const offsetAtCandidate = nyOffsetMsAt(candidate);
  const firstPass = new Date(candidate.getTime() - offsetAtCandidate);
  const offsetAtFirstPass = nyOffsetMsAt(firstPass);
  if (offsetAtFirstPass === offsetAtCandidate) {
    return firstPass; // Probes agree — the common case.
  }
  const secondPass = new Date(candidate.getTime() - offsetAtFirstPass);
  // If the offset at secondPass matches the offset we applied, secondPass
  // reads back as the requested wall clock (a real instant — the DST
  // boundary just sat between our probes). If it does NOT match, the wall
  // clock is unrepresentable (spring-forward gap): firstPass is the
  // forward resolution (requested time + gap width on the far side).
  return nyOffsetMsAt(secondPass) === offsetAtFirstPass ? secondPass : firstPass;
};
