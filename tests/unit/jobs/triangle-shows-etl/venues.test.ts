/**
 * Unit tests for the triangle-shows-etl venue partition (BS#1570
 * Decision 1). The exclusion list keeps the 5 double-covered slugs on
 * the RHP scraper; the startup assertions make venue-set drift at the
 * source fail loudly instead of silently double-ingesting or dropping
 * a venue.
 */
import { EXCLUDED_VENUE_SLUGS, partitionVenues } from '../../../../jobs/triangle-shows-etl/venues';

const venue = (slug: string) => ({
  id: Math.abs(slug.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 1000,
  name: slug,
  slug,
  city: 'Durham',
  size_category: 'small',
  color: '#000000',
});

// The full 21-venue triangle-shows set as of Phase 0.
const ALL_SLUGS = [
  'cats-cradle',
  'cats-cradle-back-room',
  'local-506',
  'motorco',
  'haw-river-ballroom',
  'the-pinhook',
  'kings',
  'slims',
  'the-fruit',
  'rubies',
  'stancyks',
  'neptunes-parlour',
  'boom-club',
  'shadowbox-studio',
  'the-cave',
  'nightlight',
  'the-ritz',
  'koka-booth',
  'dpac',
  'carolina-theatre',
  'red-hat-amphitheater',
];

describe('EXCLUDED_VENUE_SLUGS', () => {
  it('is exactly the 5 double-covered slugs from BS#1570 Decision 1', () => {
    expect([...EXCLUDED_VENUE_SLUGS].sort()).toEqual(
      ['cats-cradle', 'cats-cradle-back-room', 'haw-river-ballroom', 'local-506', 'motorco'].sort()
    );
  });
});

describe('partitionVenues', () => {
  it('returns the ingested venues (source set minus exclusions) when all assertions hold', () => {
    const ingested = partitionVenues(ALL_SLUGS.map(venue));
    expect(ingested).toHaveLength(ALL_SLUGS.length - 5);
    const slugs = ingested.map((v) => v.slug);
    for (const excluded of EXCLUDED_VENUE_SLUGS) {
      expect(slugs).not.toContain(excluded);
    }
  });

  it('throws when an excluded slug disappears from the source venue list (venue-set drift must fail loudly)', () => {
    const drifted = ALL_SLUGS.filter((s) => s !== 'haw-river-ballroom').map(venue);
    expect(() => partitionVenues(drifted)).toThrow(/haw-river-ballroom/);
  });

  it('throws when an ingested slug exceeds venues.slug varchar(64)', () => {
    const tooLong = [...ALL_SLUGS.map(venue), venue('x'.repeat(65))];
    expect(() => partitionVenues(tooLong)).toThrow(/64/);
  });

  it('throws when an ingested venue name exceeds venues.name varchar(128) — the source allows String(200), and an unguarded bind would abort the run as a raw PG 22001', () => {
    const longNamed = { ...venue('the-pinhook'), name: 'n'.repeat(129) };
    const rest = ALL_SLUGS.filter((s) => s !== 'the-pinhook').map(venue);
    expect(() => partitionVenues([...rest, longNamed])).toThrow(/128/);
  });

  it('accepts a NEW unexcluded slug (new rooms flow in; only drift on the excluded set is fatal)', () => {
    const withNewRoom = [...ALL_SLUGS.map(venue), venue('brand-new-room')];
    const ingested = partitionVenues(withNewRoom);
    expect(ingested.map((v) => v.slug)).toContain('brand-new-room');
  });
});
