/**
 * Pins the America/New_York calendar-date and wall-clock helpers shared by
 * the two concert writers (`jobs/venue-events-scraper/writer.ts` derives
 * `starts_on` from an instant; `jobs/triangle-shows-etl` composes
 * `starts_at`/`doors_at` from the source's date + local time). Both sides
 * of migration 0112's `starts_on date NOT NULL` invariant flow through
 * these, so DST correctness is pinned explicitly on both transition days.
 */
import { describe, test, expect } from '@jest/globals';
import { nyCalendarDate, nyWallClockToUtc } from '../../../shared/database/src/ny-time';

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
});

describe('nyWallClockToUtc', () => {
  test.each([
    // EST winter date: 20:00 NY == 01:00Z next day.
    ['2026-01-15', '20:00:00', '2026-01-16T01:00:00.000Z'],
    // EDT summer date: 20:00 NY == 00:00Z next day.
    ['2026-07-04', '20:00:00', '2026-07-05T00:00:00.000Z'],
    // Seconds honored, HH:MM accepted.
    ['2026-07-04', '19:30', '2026-07-04T23:30:00.000Z'],
    // Spring-forward day (2026-03-08): 02:30 NY doesn't exist; resolves to
    // the post-transition instant (03:30 EDT == 07:30Z, same as 02:30 EST
    // read forward). Either post-gap reading is 07:30Z under the two-pass
    // converge; what we pin is: not NaN, and the evening of that day is EDT.
    ['2026-03-08', '20:00:00', '2026-03-09T00:00:00.000Z'],
    // Fall-back day (2026-11-01): 01:30 NY is ambiguous; two-pass converge
    // lands on a valid instant whose NY reading is 01:30 — pin the evening
    // of that day as EST.
    ['2026-11-01', '20:00:00', '2026-11-02T01:00:00.000Z'],
  ])('nyWallClockToUtc(%s, %s) -> %s', (date, time, expectedIso) => {
    expect(nyWallClockToUtc(date, time).toISOString()).toBe(expectedIso);
  });

  test('spring-forward gap time resolves to a valid instant that round-trips to the same NY calendar date', () => {
    const instant = nyWallClockToUtc('2026-03-08', '02:30:00');
    expect(Number.isNaN(instant.getTime())).toBe(false);
    expect(nyCalendarDate(instant)).toBe('2026-03-08');
  });

  test('fall-back ambiguous time resolves to a valid instant on the same NY calendar date', () => {
    const instant = nyWallClockToUtc('2026-11-01', '01:30:00');
    expect(Number.isNaN(instant.getTime())).toBe(false);
    expect(nyCalendarDate(instant)).toBe('2026-11-01');
  });
});
