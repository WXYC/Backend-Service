/**
 * Unit tests for the venue partition (BS#1570 Decision 1): the 5
 * double-covered RHP slugs are excluded from ingestion, and venue-set
 * drift at the source fails the run loudly instead of silently
 * double-scraping or silently dropping coverage.
 */
import {
  EXCLUDED_VENUE_SLUGS,
  assertVenuePartition,
  ingestedVenues,
  isExcluded,
} from '../../../../jobs/triangle-shows-etl/venues';
import type { TsVenue } from '../../../../jobs/triangle-shows-etl/types';

const venue = (slug: string, overrides: Partial<TsVenue> = {}): TsVenue => ({
  id: 1,
  name: slug,
  slug,
  city: 'Durham',
  capacity: null,
  size_category: 'small',
  website: null,
  color: '#000000',
  ...overrides,
});

// The 21-venue triangle-shows seed as of 2026-07-10 (backend/app/seed.py) —
// the 5 excluded slugs plus 16 ingested.
const ALL_SOURCE_SLUGS = [
  'koka-booth',
  'red-hat',
  'dpac',
  'the-ritz',
  'lincoln-theatre',
  'cats-cradle',
  'motorco',
  'local-506',
  'the-pinhook',
  'kings',
  'cats-cradle-back-room',
  'the-cave',
  'haw-river-ballroom',
  'neptunes-parlour',
  'shadowbox-studio',
  'rubies',
  'stancyks',
  'boom-club',
  'chapel-of-bones',
  'pour-house',
  'slims',
];

const sourceVenues = ALL_SOURCE_SLUGS.map((s) => venue(s));

describe('EXCLUDED_VENUE_SLUGS', () => {
  it('is exactly the 5 RHP-covered triangle-shows slugs (partition by venue, BS#1570 Decision 1)', () => {
    expect([...EXCLUDED_VENUE_SLUGS].sort()).toEqual(
      ['cats-cradle', 'cats-cradle-back-room', 'haw-river-ballroom', 'local-506', 'motorco'].sort()
    );
  });

  it('uses triangle-shows slugs, not BS venue seeds (BS seeds Motorco as motorco-music-hall)', () => {
    expect(EXCLUDED_VENUE_SLUGS).toContain('motorco');
    expect(EXCLUDED_VENUE_SLUGS).not.toContain('motorco-music-hall');
  });
});

describe('assertVenuePartition', () => {
  it('passes on the current 21-venue source list', () => {
    expect(() => assertVenuePartition(sourceVenues)).not.toThrow();
  });

  it('throws when an excluded slug disappears from the source (venue-set drift must fail loudly)', () => {
    const withoutMotorco = sourceVenues.filter((v) => v.slug !== 'motorco');
    expect(() => assertVenuePartition(withoutMotorco)).toThrow(/motorco/);
  });

  it('names every missing excluded slug, not just the first', () => {
    const drifted = sourceVenues.filter((v) => v.slug !== 'motorco' && v.slug !== 'local-506');
    expect(() => assertVenuePartition(drifted)).toThrow(/motorco[\s\S]*local-506|local-506[\s\S]*motorco/);
  });

  it('throws when an ingested venue slug would overflow venues.slug varchar(64)', () => {
    const withLongSlug = [...sourceVenues, venue('x'.repeat(65))];
    expect(() => assertVenuePartition(withLongSlug)).toThrow(/64/);
  });

  it('does NOT length-check excluded slugs (they never get provisioned)', () => {
    // Degenerate by construction — excluded slugs are a fixed 5-element
    // list, all short — but pin the scope so a refactor doesn't tighten
    // the assertion onto rows we never write.
    expect(() => assertVenuePartition(sourceVenues)).not.toThrow();
  });
});

describe('ingestedVenues / isExcluded', () => {
  it('partitions the source list into the 16 ingested venues', () => {
    const ingested = ingestedVenues(sourceVenues);
    expect(ingested).toHaveLength(16);
    expect(ingested.map((v) => v.slug)).not.toEqual(expect.arrayContaining(['cats-cradle']));
  });

  it('isExcluded matches exactly the exclusion list', () => {
    expect(isExcluded('cats-cradle')).toBe(true);
    expect(isExcluded('pinhook')).toBe(false);
    // Prefix confusion must not exclude: back-room IS excluded, but a
    // hypothetical future 'cats-cradle-annex' would not be.
    expect(isExcluded('cats-cradle-back-room')).toBe(true);
    expect(isExcluded('cats-cradle-annex')).toBe(false);
  });
});
