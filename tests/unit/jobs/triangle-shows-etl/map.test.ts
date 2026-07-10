/**
 * Unit tests for the triangle-shows-etl pure mapping layer (BS#1589).
 *
 * Everything here is DB-free: mapEvent and its helpers transform one
 * source EventResponse into the concerts row shape. The acceptance
 * criteria pinned in this file: venue-qualified keying (including the
 * cross-venue same-source_key collision pair), status mapping including
 * `free`, `artist ?? name` truncation at 256, starts_at/doors_at
 * composition including date-only events, and support_artists splitting.
 */
import { mapEvent, splitSupportArtists, type TriangleShowsEvent } from '../../../../jobs/triangle-shows-etl/map';

const fakeEvent = (overrides: Partial<TriangleShowsEvent> = {}): TriangleShowsEvent => ({
  id: 1,
  venue_id: 10,
  name: 'Jessica Pratt',
  artist: 'Jessica Pratt',
  support_artists: null,
  date: '2026-11-06',
  doors_time: null,
  show_time: '20:00:00',
  ticket_url: 'https://example.com/tickets/1',
  price_min: 15,
  price_max: 18,
  image_url: null,
  genre: null,
  subgenre: null,
  status: 'on_sale',
  age_restriction: null,
  description: null,
  source: 'venuepilot',
  source_key: 'ext:12345',
  updated_at: '2026-07-09T12:00:00+00:00',
  removed_at: null,
  venue_name: 'Ruby Deluxe',
  venue_slug: 'rubies',
  venue_city: 'Raleigh',
  venue_color: '#aa0000',
  ...overrides,
});

describe('venue-qualified keying', () => {
  it('prefixes source_id with the venue slug and a colon — never bare source_key', () => {
    const mapped = mapEvent(fakeEvent(), 'rubies');
    expect(mapped.source_id).toBe('rubies:ext:12345');
  });

  it('keeps the cross-venue same-source_key collision pair distinct (rubies + stancyks are both VenuePilot)', () => {
    // Same platform, same numeric external id — the exact collision the
    // bare-source_key keying would merge into one row (BS#1570 third pass).
    const atRubies = mapEvent(fakeEvent({ venue_slug: 'rubies', source_key: 'ext:777' }), 'rubies');
    const atStancyks = mapEvent(fakeEvent({ venue_id: 11, venue_slug: 'stancyks', source_key: 'ext:777' }), 'stancyks');
    expect(atRubies.source_id).toBe('rubies:ext:777');
    expect(atStancyks.source_id).toBe('stancyks:ext:777');
    expect(atRubies.source_id).not.toBe(atStancyks.source_id);
  });
});

describe('status mapping', () => {
  it.each([
    ['on_sale', 'on_sale'],
    ['sold_out', 'sold_out'],
    ['cancelled', 'cancelled'],
  ] as const)('maps %s to %s unchanged', (source, expected) => {
    expect(mapEvent(fakeEvent({ status: source }), 'rubies').status).toBe(expected);
  });

  it('maps free to on_sale with price_min = 0', () => {
    const mapped = mapEvent(fakeEvent({ status: 'free', price_min: null, price_max: null }), 'rubies');
    expect(mapped.status).toBe('on_sale');
    expect(mapped.price_min).toBe('0.00');
    expect(mapped.price_max).toBeNull();
  });

  it('keeps a source-provided price on a free event rather than clobbering it to 0', () => {
    // 'free' with a price is a source contradiction; trust the explicit
    // number over the derived zero.
    const mapped = mapEvent(fakeEvent({ status: 'free', price_min: 5 }), 'rubies');
    expect(mapped.status).toBe('on_sale');
    expect(mapped.price_min).toBe('5.00');
  });

  it('throws on a status outside the source enum instead of guessing (surfaces as a per-event map_error)', () => {
    expect(() => mapEvent(fakeEvent({ status: 'postponed' }), 'rubies')).toThrow(/status/i);
  });
});

describe('headlining_artist_raw (artist ?? name, truncated to 256)', () => {
  it('prefers artist when present', () => {
    const mapped = mapEvent(fakeEvent({ artist: 'Juana Molina', name: 'Juana Molina with guests' }), 'rubies');
    expect(mapped.headlining_artist_raw).toBe('Juana Molina');
  });

  it('falls back to name when artist is null (name is NOT NULL at the source, so the fallback is total)', () => {
    const mapped = mapEvent(fakeEvent({ artist: null, name: 'Chuquimamani-Condori' }), 'rubies');
    expect(mapped.headlining_artist_raw).toBe('Chuquimamani-Condori');
  });

  it('falls back to name when artist is empty or whitespace-only (source scrapers can emit "" — nullish coalescing alone would keep it)', () => {
    expect(mapEvent(fakeEvent({ artist: '', name: 'Jessica Pratt' }), 'rubies').headlining_artist_raw).toBe(
      'Jessica Pratt'
    );
    expect(mapEvent(fakeEvent({ artist: '   ', name: 'Juana Molina' }), 'rubies').headlining_artist_raw).toBe(
      'Juana Molina'
    );
  });

  it('throws (a countable map_error) when artist AND name are both blank — an empty headliner satisfies the NOT NULL constraint but is unresolvable garbage', () => {
    expect(() => mapEvent(fakeEvent({ artist: null, name: '   ' }), 'rubies')).toThrow(/blank/i);
    expect(() => mapEvent(fakeEvent({ artist: ' ', name: '' }), 'rubies')).toThrow(/blank/i);
  });

  it('truncates to 256 chars (source name is String(500); concerts column is varchar(256))', () => {
    const long = 'x'.repeat(500);
    const mapped = mapEvent(fakeEvent({ artist: long }), 'rubies');
    expect(mapped.headlining_artist_raw).toHaveLength(256);
    expect(mapped.headlining_artist_raw).toBe(long.slice(0, 256));
  });

  it('truncates on code points, never splitting a surrogate pair at the boundary (a lone surrogate reaches PG as U+FFFD)', () => {
    // 255 BMP chars then an astral char: a UTF-16 .slice(0, 256) would cut
    // the pair in half. Code-point truncation keeps the whole emoji
    // (PG's varchar(256) counts characters, so 255 + 1 astral fits).
    const input = 'x'.repeat(255) + '\u{1F3B8}' + 'trailing';
    const mapped = mapEvent(fakeEvent({ artist: input }), 'rubies');
    expect(mapped.headlining_artist_raw.endsWith('\u{1F3B8}')).toBe(true);
    expect([...mapped.headlining_artist_raw]).toHaveLength(256);
  });
});

describe('starts_at / doors_at composition (America/New_York)', () => {
  it('composes date + show_time as an Eastern wall-clock moment (EST, UTC-5)', () => {
    const mapped = mapEvent(fakeEvent({ date: '2026-11-06', show_time: '20:00:00' }), 'rubies');
    expect(mapped.starts_at?.toISOString()).toBe('2026-11-07T01:00:00.000Z');
  });

  it('composes with the DST offset when the date is in EDT (UTC-4)', () => {
    const mapped = mapEvent(fakeEvent({ date: '2026-07-15', show_time: '20:00:00' }), 'rubies');
    expect(mapped.starts_at?.toISOString()).toBe('2026-07-16T00:00:00.000Z');
  });

  it('leaves starts_at NULL for date-only events — no fabricated times', () => {
    const mapped = mapEvent(fakeEvent({ show_time: null }), 'rubies');
    expect(mapped.starts_at).toBeNull();
    // starts_on still carries the calendar date, verbatim from the source.
    expect(mapped.starts_on).toBe('2026-11-06');
  });

  it('composes doors_at from doors_time and leaves it NULL when absent', () => {
    const withDoors = mapEvent(fakeEvent({ doors_time: '19:00:00' }), 'rubies');
    expect(withDoors.doors_at?.toISOString()).toBe('2026-11-07T00:00:00.000Z');
    const withoutDoors = mapEvent(fakeEvent({ doors_time: null }), 'rubies');
    expect(withoutDoors.doors_at).toBeNull();
  });

  it('takes starts_on verbatim from the source date — never re-derived from starts_at', () => {
    const mapped = mapEvent(fakeEvent({ date: '2026-12-31', show_time: '23:30:00' }), 'rubies');
    expect(mapped.starts_on).toBe('2026-12-31');
  });
});

// DST gap/ambiguity behavior of the time composition is pinned by the shared
// helper's own suite (tests/unit/database/ny-time.test.ts) — mapEvent
// delegates to nyWallClockToUtc and the composition tests above cover the
// EST/EDT offsets through the public surface.

describe('support_artists splitting', () => {
  it('splits the single comma-separated string into a trimmed array', () => {
    expect(splitSupportArtists('Jessica Pratt, Juana Molina,Stereolab')).toEqual([
      'Jessica Pratt',
      'Juana Molina',
      'Stereolab',
    ]);
  });

  it('returns [] for null and for whitespace-only input', () => {
    expect(splitSupportArtists(null)).toEqual([]);
    expect(splitSupportArtists('   ')).toEqual([]);
  });

  it('drops empty segments from stray commas', () => {
    expect(splitSupportArtists('Cat Power,, ,')).toEqual(['Cat Power']);
  });

  it('threads through mapEvent into supporting_artists_raw', () => {
    const mapped = mapEvent(fakeEvent({ support_artists: 'Cat Power, Stereolab' }), 'rubies');
    expect(mapped.supporting_artists_raw).toEqual(['Cat Power', 'Stereolab']);
  });
});

describe('remaining field mapping', () => {
  it('carries title, urls, age_restriction, prices, and the full raw payload', () => {
    const event = fakeEvent({
      name: 'An Evening with Jessica Pratt',
      age_restriction: '18+',
      price_min: 15.5,
      price_max: 20,
      image_url: 'https://example.com/img.jpg',
    });
    const mapped = mapEvent(event, 'rubies');
    expect(mapped.title).toBe('An Evening with Jessica Pratt');
    expect(mapped.age_restriction).toBe('18+');
    expect(mapped.price_min).toBe('15.50');
    expect(mapped.price_max).toBe('20.00');
    expect(mapped.ticket_url).toBe('https://example.com/tickets/1');
    expect(mapped.image_url).toBe('https://example.com/img.jpg');
    expect(mapped.raw).toEqual(event);
  });

  it('drops an un-storable price instead of failing the whole event (numeric(8,2) caps at 999999.99; source floats are unbounded and scrapers can misparse prose digits as prices)', () => {
    const mapped = mapEvent(fakeEvent({ price_min: 20242025, price_max: 9195551234 }), 'rubies');
    expect(mapped.price_min).toBeNull();
    expect(mapped.price_max).toBeNull();
    // Boundary: the largest storable value survives.
    expect(mapEvent(fakeEvent({ price_min: 999999.99 }), 'rubies').price_min).toBe('999999.99');
    expect(mapEvent(fakeEvent({ price_min: Number.POSITIVE_INFINITY }), 'rubies').price_min).toBeNull();
    // toFixed ROUNDS: 999999.996 formats to '1000000.00', which overflows
    // numeric(8,2) — the clamp must judge the rounded value, not the raw one.
    expect(mapEvent(fakeEvent({ price_min: 999999.996 }), 'rubies').price_min).toBeNull();
  });

  it('mirrors removed_at as a Date when the source tombstoned the event, null otherwise', () => {
    const tombstoned = mapEvent(fakeEvent({ removed_at: '2026-07-01T05:00:00+00:00' }), 'rubies');
    expect(tombstoned.removed_at?.toISOString()).toBe('2026-07-01T05:00:00.000Z');
    const live = mapEvent(fakeEvent({ removed_at: null }), 'rubies');
    expect(live.removed_at).toBeNull();
  });
});
