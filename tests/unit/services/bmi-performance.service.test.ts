import { describe, it, expect } from '@jest/globals';
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
});

describe('bmi-performance.service: summarizeCoverage', () => {
  const row = (composer_source: string | null, composer: string | null): BmiPerformanceRow => ({
    artist_name: 'Jessica Pratt',
    track_title: 'Back, Baby',
    album_title: 'On Your Own Love Again',
    record_label: 'Drag City',
    composer,
    composer_source: composer_source as BmiPerformanceRow['composer_source'],
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
    });
  });

  it('summarizes an empty list to all-zero counts', () => {
    expect(summarizeCoverage([])).toEqual({
      total: 0,
      real_track: 0,
      real_release: 0,
      artist_proxy: 0,
      none: 0,
    });
  });
});
