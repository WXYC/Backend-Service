import { describe, it, expect, jest } from '@jest/globals';
import {
  parseBmiDateRange,
  summarizeCoverage,
  projectBmiRow,
  type BmiPerformanceRow,
} from '../../../apps/backend/services/bmi-performance.service';
import WxycError from '../../../apps/backend/utils/error';

// BS#1500 — successor to tubafrenzy's `recentBMI` export. The endpoint's
// output *format* is deferred to #1507 (whatever BMI accepts), but its
// date-range contract, the entry/composer projection, and the coverage
// summary the dj-site preview reads are stable and pinned here.

const rawRow = (overrides: Record<string, unknown> = {}) => ({
  artist_name: 'Juana Molina',
  track_title: 'la paradoja',
  album_title: 'DOGA',
  record_label: 'Sonamos',
  composer: 'Juana Molina',
  composer_source: 'discogs_track',
  add_time: new Date('2026-03-15T18:42:00.000Z'),
  ...overrides,
});

describe('bmi-performance.service: parseBmiDateRange', () => {
  it('accepts a valid YYYY-MM-DD range and yields an inclusive [from, to] window as a half-open interval', () => {
    const range = parseBmiDateRange('2026-01-01', '2026-06-30');

    expect(range.from).toBe('2026-01-01');
    expect(range.to).toBe('2026-06-30');
    // Lower bound is the start of `from`; upper bound is the start of the day
    // AFTER `to`, so the whole `to` day is included (half-open interval).
    expect(range.fromDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(range.toExclusive.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rolls the exclusive upper bound across a month boundary correctly', () => {
    const range = parseBmiDateRange('2026-01-31', '2026-01-31');
    expect(range.fromDate.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(range.toExclusive.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it.each([
    ['both missing', undefined, undefined],
    ['from missing', undefined, '2026-06-30'],
    ['to missing', '2026-01-01', undefined],
    ['empty string', '', '2026-06-30'],
  ])('throws WxycError(400) when a bound is absent (%s)', (_label, from, to) => {
    expect(() => parseBmiDateRange(from, to)).toThrow(WxycError);
    try {
      parseBmiDateRange(from, to);
    } catch (e) {
      expect((e as WxycError).statusCode).toBe(400);
    }
  });

  it.each([
    ['not ISO', '01/01/2026', '2026-06-30'],
    ['timestamp not date', '2026-01-01T00:00:00Z', '2026-06-30'],
    ['impossible calendar date', '2026-02-30', '2026-06-30'],
  ])('throws WxycError(400) on a malformed bound (%s)', (_label, from, to) => {
    expect(() => parseBmiDateRange(from, to)).toThrow(WxycError);
  });

  it('throws WxycError(400) when from is after to', () => {
    expect(() => parseBmiDateRange('2026-06-30', '2026-01-01')).toThrow(WxycError);
  });

  it('accepts a single-day range (from === to)', () => {
    const range = parseBmiDateRange('2026-03-15', '2026-03-15');
    expect(range.fromDate.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(range.toExclusive.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('accepts a range at the maximum window width (366 inclusive days)', () => {
    // 2024 is a leap year: 2024-01-01..2024-12-31 is exactly 366 inclusive days.
    const range = parseBmiDateRange('2024-01-01', '2024-12-31');
    expect(range.fromDate.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(range.toExclusive.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('throws WxycError(400) when the window exceeds the maximum width', () => {
    // 367 inclusive days — one past the cap. Guards the unbounded-result-set /
    // event-loop-block risk (the underlying read has no LIMIT).
    expect(() => parseBmiDateRange('2024-01-01', '2025-01-01')).toThrow(WxycError);
    try {
      parseBmiDateRange('2024-01-01', '2025-01-01');
    } catch (e) {
      expect((e as WxycError).statusCode).toBe(400);
    }
  });
});

describe('bmi-performance.service: projectBmiRow', () => {
  it('projects exactly the BMI contract fields, ISO-stamping the play time', () => {
    const projected = projectBmiRow(rawRow());

    expect(Object.keys(projected).sort()).toEqual(
      ['album_title', 'artist_name', 'composer', 'composer_source', 'played_at', 'record_label', 'track_title'].sort()
    );
    expect(projected.played_at).toBe('2026-03-15T18:42:00.000Z');
    expect(projected.artist_name).toBe('Juana Molina');
    expect(projected.composer_source).toBe('discogs_track');
  });

  it('does not leak server-only columns present on the source row', () => {
    const projected = projectBmiRow(
      rawRow({ search_doc: 'juana molina', dj_name: 'DJ Nightowl', metadata_status: 'complete' })
    );
    expect(projected).not.toHaveProperty('search_doc');
    expect(projected).not.toHaveProperty('dj_name');
    expect(projected).not.toHaveProperty('metadata_status');
  });

  it('carries a null composer/composer_source through as null (un-enriched play)', () => {
    const projected = projectBmiRow(rawRow({ composer: null, composer_source: null }));
    expect(projected.composer).toBeNull();
    expect(projected.composer_source).toBeNull();
  });

  it('preserves an unrecognized composer_source verbatim rather than coercing it', () => {
    // `composer_source` is open-ended text; a source added after this shell
    // (e.g. `musicbrainz_work`) must survive on the row, not be dropped/cast away.
    const projected = projectBmiRow(rawRow({ composer_source: 'musicbrainz_work' }));
    expect(projected.composer_source).toBe('musicbrainz_work');
  });
});

describe('bmi-performance.service: summarizeCoverage', () => {
  // Restore any console.warn spy even if an assertion in a test throws first — the unit
  // config sets clearMocks (call data) but not restoreMocks (original impl), so without
  // this a thrown assertion would leave console.warn stubbed for the rest of the worker.
  afterEach(() => jest.restoreAllMocks());

  const row = (composer_source: string | null, composer: string | null): BmiPerformanceRow => ({
    artist_name: 'Jessica Pratt',
    track_title: 'Back, Baby',
    album_title: 'On Your Own Love Again',
    record_label: 'Drag City',
    composer,
    composer_source,
    played_at: '2026-03-15T18:42:00.000Z',
  });

  it('buckets rows by composer provenance so the dj-site preview can warn before submit', () => {
    const rows = [
      row('discogs_track', 'A'),
      row('discogs_track', 'B'),
      row('discogs_release', 'C'),
      row('artist_proxy', 'Jessica Pratt'),
      row(null, null),
    ];

    expect(summarizeCoverage(rows)).toEqual({
      total: 5,
      real_track: 2,
      real_release: 1,
      artist_proxy: 1,
      none: 1,
      unknown: 0,
    });
  });

  it('counts an unrecognized composer_source as `unknown`, never as `none`, and warns once', () => {
    // A future provenance (added without a migration, e.g. `musicbrainz_work`) is a
    // real writer credit; folding it into `none` would tell the librarian a credited
    // play has no composer. It must land in `unknown`, distinct from the null case,
    // and surface a single warn naming the unrecognized value.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = [row('musicbrainz_work', 'X'), row('musicbrainz_work', 'Y'), row(null, null)];

    expect(summarizeCoverage(rows)).toEqual({
      total: 3,
      real_track: 0,
      real_release: 0,
      artist_proxy: 0,
      none: 1,
      unknown: 2,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('musicbrainz_work'));
    // Restore is handled by afterEach so a thrown assertion above still cleans up.
  });

  it('summarizes an empty list to all-zero counts', () => {
    expect(summarizeCoverage([])).toEqual({
      total: 0,
      real_track: 0,
      real_release: 0,
      artist_proxy: 0,
      none: 0,
      unknown: 0,
    });
  });
});
