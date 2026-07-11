/**
 * Pins the America/New_York calendar-date and wall-clock helpers shared by
 * the two concert writers (`jobs/venue-events-scraper/writer.ts` derives
 * `starts_on` from an instant; `jobs/triangle-shows-etl` composes
 * `starts_at`/`doors_at` from the source's date + local time). Both sides
 * of migration 0112's `starts_on date NOT NULL` invariant flow through
 * these, so DST correctness is pinned explicitly on both transition days.
 */
import { describe, test, expect } from '@jest/globals';
import { NY_TIME_ZONE, nyCalendarDate, nyStartOfDay, nyWallClockToUtc } from '../../../shared/database/src/ny-time';

describe('NY_TIME_ZONE', () => {
  test('is the canonical IANA name (consumers import this instead of re-hardcoding)', () => {
    expect(NY_TIME_ZONE).toBe('America/New_York');
  });
});

describe('nyCalendarDate', () => {
  test.each([
    // EST (UTC-5): 2026-01-15T04:59Z is still Jan 14 in New York.
    ['2026-01-15T04:59:00Z', '2026-01-14'],
    ['2026-01-15T05:00:00Z', '2026-01-15'],
    // EDT (UTC-4): 2026-07-04T03:59Z is still Jul 3 in New York.
    ['2026-07-04T03:59:00Z', '2026-07-03'],
    ['2026-07-04T04:00:00Z', '2026-07-04'],
    // The RHP-writer regression case: a late show stored as an 01:30 UTC
    // instant belongs to the PREVIOUS Eastern calendar day.
    ['2026-06-14T01:30:00Z', '2026-06-13'],
  ])('nyCalendarDate(%s) -> %s', (iso, expected) => {
    expect(nyCalendarDate(new Date(iso))).toBe(expected);
  });

  test('output always matches the YYYY-MM-DD shape the date column expects (full-icu guard)', () => {
    expect(nyCalendarDate(new Date('2026-06-14T01:30:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('nyStartOfDay', () => {
  test.each([
    // EST (UTC-5): midnight ET on 2026-01-15 is 05:00Z.
    ['2026-01-15T18:00:00Z', '2026-01-15T05:00:00.000Z'],
    // An instant just after EST midnight still floors to the same 05:00Z.
    ['2026-01-15T05:00:01Z', '2026-01-15T05:00:00.000Z'],
    // An instant just BEFORE EST midnight belongs to the previous ET day
    // (04:59Z on the 15th is still Jan 14 in NY -> 2026-01-14T05:00Z).
    ['2026-01-15T04:59:00Z', '2026-01-14T05:00:00.000Z'],
    // EDT (UTC-4): midnight ET on 2026-07-04 is 04:00Z.
    ['2026-07-04T18:00:00Z', '2026-07-04T04:00:00.000Z'],
  ])('nyStartOfDay(%s) -> %s', (iso, expectedIso) => {
    expect(nyStartOfDay(new Date(iso)).toISOString()).toBe(expectedIso);
  });

  test('the returned instant floors to its own ET calendar date (round-trips through nyCalendarDate)', () => {
    const start = nyStartOfDay(new Date('2026-07-04T18:00:00Z'));
    expect(nyCalendarDate(start)).toBe('2026-07-04');
  });

  test('ET-midnight rollover advances the start-of-day instant deterministically (injectable now)', () => {
    // The conditional-GET watermark fold (BS#1607) relies on this jump: a
    // request one second BEFORE ET midnight and one second AFTER must resolve
    // to different start-of-day instants exactly one ET day apart, so a
    // pre-midnight If-Modified-Since goes stale at the rollover. EST here.
    const justBeforeMidnightET = new Date('2026-01-16T04:59:59Z'); // 23:59:59 ET on the 15th
    const justAfterMidnightET = new Date('2026-01-16T05:00:01Z'); // 00:00:01 ET on the 16th
    expect(nyStartOfDay(justBeforeMidnightET).toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(nyStartOfDay(justAfterMidnightET).toISOString()).toBe('2026-01-16T05:00:00.000Z');
    expect(nyStartOfDay(justAfterMidnightET).getTime()).toBeGreaterThan(nyStartOfDay(justBeforeMidnightET).getTime());
  });

  test('defaults to the current instant when called with no argument', () => {
    // Same-ET-day contract: the default-arg path must agree with an explicit
    // `new Date()` reading (both floor to today's ET midnight).
    expect(nyStartOfDay().toISOString()).toBe(nyStartOfDay(new Date()).toISOString());
  });
});

describe('nyWallClockToUtc', () => {
  test.each([
    // EST winter date: 20:00 NY == 01:00Z next day.
    ['2026-01-15', '20:00:00', '2026-01-16T01:00:00.000Z'],
    // EDT summer date: 20:00 NY == 00:00Z next day.
    ['2026-07-04', '20:00:00', '2026-07-05T00:00:00.000Z'],
    // Seconds optional; HH:MM accepted.
    ['2026-07-04', '19:30', '2026-07-04T23:30:00.000Z'],
    // Unpadded hour accepted ('9:30' — some feeds emit it).
    ['2026-07-04', '9:30', '2026-07-04T13:30:00.000Z'],
    // Evening of the spring-forward day is EDT.
    ['2026-03-08', '20:00:00', '2026-03-09T00:00:00.000Z'],
    // Evening of the fall-back day is EST.
    ['2026-11-01', '20:00:00', '2026-11-02T01:00:00.000Z'],
    // Just before the spring-forward gap: 01:30 EST.
    ['2026-03-08', '01:30:00', '2026-03-08T06:30:00.000Z'],
    // Just after the gap: 03:30 EDT.
    ['2026-03-08', '03:30:00', '2026-03-08T07:30:00.000Z'],
    // Fractional seconds accepted and truncated: Pydantic serializes a
    // Python time via isoformat(), which emits microseconds whenever they
    // are nonzero — concretely produced by triangle-shows' Squarespace
    // scraper (datetime.fromtimestamp(ms / 1000) keeps sub-second
    // precision). Rejecting the shape would permanently map_error those
    // venues' events.
    ['2026-07-04', '20:00:00.123000', '2026-07-05T00:00:00.000Z'],
    ['2026-07-04', '19:30:15.5', '2026-07-04T23:30:15.000Z'],
  ])('nyWallClockToUtc(%s, %s) -> %s', (date, time, expectedIso) => {
    expect(nyWallClockToUtc(date, time).toISOString()).toBe(expectedIso);
  });

  test('spring-forward gap time resolves FORWARD to the post-transition instant (Temporal-"compatible" policy)', () => {
    // 02:30 on 2026-03-08 does not exist in New York; the documented
    // resolution is 03:30 EDT == 07:30Z. Pinning the exact instant (not
    // just "some valid instant") is what keeps the implementation honest
    // about which side of the gap it lands on.
    const instant = nyWallClockToUtc('2026-03-08', '02:30:00');
    expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(nyCalendarDate(instant)).toBe('2026-03-08');
  });

  test('fall-back ambiguous time resolves to the FIRST (EDT) occurrence', () => {
    // 01:30 on 2026-11-01 happens twice; "compatible" picks the earlier
    // one: 01:30 EDT == 05:30Z (the second would be 06:30Z EST).
    const instant = nyWallClockToUtc('2026-11-01', '01:30:00');
    expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(nyCalendarDate(instant)).toBe('2026-11-01');
  });

  test.each([
    ['2026-07-04', '25:00:00'], // out-of-range hour
    // ECMA-262 quietly accepts T24:00 as next-day midnight, which would
    // window the event a day late with no error — rejected explicitly.
    ['2026-07-04', '24:00'],
    ['2026-07-04', '24:00:00'],
    ['2026-07-04', '19'], // not HH:MM[:SS]
    ['2026-07-04', '19:30:00-05:00'], // offset suffix not part of the contract
    ['07/04/2026', '19:30:00'], // date must be ISO
    ['2026-07-04', ''],
  ])('rejects malformed input %s / %s with a clear error', (date, time) => {
    expect(() => nyWallClockToUtc(date, time)).toThrow(/nyWallClockToUtc/);
  });
});

describe('nyCalendarDate — invalid input', () => {
  test("throws an attributed error on an Invalid Date (not Intl's bare RangeError)", () => {
    expect(() => nyCalendarDate(new Date('not a date'))).toThrow(/nyCalendarDate/);
  });
});
