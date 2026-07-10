/**
 * Unit tests for the triangle-shows ETL's pure event -> concerts-row
 * mapping (BS#1589 field table). No DB, no network — `mapEvent` and its
 * helpers are pure, so the whole contract pins here.
 */
import { mapEvent, splitSupportArtists, backdatedStart } from '../../../../jobs/triangle-shows-etl/map';
import type { TsEvent } from '../../../../jobs/triangle-shows-etl/types';

const baseEvent = (overrides: Partial<TsEvent> = {}): TsEvent => ({
  id: 101,
  venue_id: 3,
  name: 'Jessica Pratt',
  artist: 'Jessica Pratt',
  support_artists: null,
  date: '2026-08-14',
  doors_time: null,
  show_time: null,
  ticket_url: 'https://example.com/tickets/101',
  price_min: 18,
  price_max: 22,
  image_url: 'https://example.com/101.jpg',
  genre: 'folk',
  subgenre: null,
  status: 'on_sale',
  age_restriction: null,
  description: null,
  source: 'venuepilot',
  source_key: 'ext:12345',
  updated_at: '2026-07-09T12:00:00+00:00',
  removed_at: null,
  venue_name: 'The Pinhook',
  venue_slug: 'pinhook',
  venue_city: 'Durham',
  venue_color: '#aa00aa',
  ...overrides,
});

describe('mapEvent — keying', () => {
  // The venue qualifier is load-bearing (BS#1589 "Keying"): triangle-shows
  // uniqueness is per-venue `(venue_id, source_key)` — its README's
  // uniqueness paragraph is explicit that `source_key` ALONE is not unique
  // (VenuePilot external ids are small integers that collide across
  // venues). Keying on bare source_key would fold distinct venues'
  // concerts into one row via the (source, source_id) unique index.
  it('composes source_id as venue_slug + ":" + source_key', () => {
    const mapped = mapEvent(baseEvent());
    expect(mapped.concert.source_id).toBe('pinhook:ext:12345');
    expect(mapped.concert.source).toBe('triangle_shows');
  });

  it('keeps a cross-venue same-source_key collision pair distinct', () => {
    const a = mapEvent(baseEvent({ venue_slug: 'rubies', source_key: 'ext:123' }));
    const b = mapEvent(baseEvent({ venue_slug: 'stancyks', source_key: 'ext:123' }));
    expect(a.concert.source_id).toBe('rubies:ext:123');
    expect(b.concert.source_id).toBe('stancyks:ext:123');
    expect(a.concert.source_id).not.toBe(b.concert.source_id);
  });

  it('throws on a missing venue_slug (cannot key without the qualifier)', () => {
    expect(() => mapEvent(baseEvent({ venue_slug: null }))).toThrow(/venue_slug/);
  });
});

describe('mapEvent — dates and times', () => {
  it('maps date to starts_on and composes starts_at from date + show_time in America/New_York', () => {
    const mapped = mapEvent(baseEvent({ show_time: '20:00:00' }));
    expect(mapped.concert.starts_on).toBe('2026-08-14');
    // 20:00 EDT == 00:00Z next day.
    expect(mapped.concert.starts_at?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('leaves starts_at NULL for date-only events (no fabricated times)', () => {
    const mapped = mapEvent(baseEvent({ show_time: null, doors_time: null }));
    expect(mapped.concert.starts_on).toBe('2026-08-14');
    expect(mapped.concert.starts_at).toBeNull();
    expect(mapped.concert.doors_at).toBeNull();
  });

  it('composes doors_at from doors_time independently of show_time', () => {
    const mapped = mapEvent(baseEvent({ doors_time: '19:00:00', show_time: null }));
    expect(mapped.concert.doors_at?.toISOString()).toBe('2026-08-14T23:00:00.000Z');
    expect(mapped.concert.starts_at).toBeNull();
  });

  it('uses the EST offset for winter dates', () => {
    const mapped = mapEvent(baseEvent({ date: '2026-12-04', show_time: '20:00:00' }));
    expect(mapped.concert.starts_on).toBe('2026-12-04');
    expect(mapped.concert.starts_at?.toISOString()).toBe('2026-12-05T01:00:00.000Z');
  });
});

describe('mapEvent — headliner and title', () => {
  it('prefers artist over name for headlining_artist_raw and carries name as title', () => {
    const mapped = mapEvent(baseEvent({ artist: 'Juana Molina', name: 'Juana Molina — DOGA tour' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Juana Molina');
    expect(mapped.concert.title).toBe('Juana Molina — DOGA tour');
  });

  it('falls back to name when artist is null (name is NOT NULL at the source, so the mapping is total)', () => {
    const mapped = mapEvent(baseEvent({ artist: null, name: 'Duke Ellington & John Coltrane' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Duke Ellington & John Coltrane');
  });

  it('truncates headlining_artist_raw to 256 (source String(500) vs concerts varchar(256))', () => {
    const long = 'x'.repeat(500);
    const mapped = mapEvent(baseEvent({ artist: long }));
    expect(mapped.concert.headlining_artist_raw).toHaveLength(256);
    expect(mapped.concert.headlining_artist_raw).toBe(long.slice(0, 256));
  });
});

describe('splitSupportArtists', () => {
  it.each([
    [null, []],
    ['', []],
    ['Chuquimamani-Condori', ['Chuquimamani-Condori']],
    ['Stereolab, Cat Power', ['Stereolab', 'Cat Power']],
    // Internal empty element and padding whitespace both dropped.
    ['Artist A, , Artist B', ['Artist A', 'Artist B']],
    ['  Nilüfer Yanya ,Hermanos Gutiérrez  ', ['Nilüfer Yanya', 'Hermanos Gutiérrez']],
  ])('splitSupportArtists(%j) -> %j', (input, expected) => {
    expect(splitSupportArtists(input)).toEqual(expected);
  });

  it('is what mapEvent feeds supporting_artists_raw', () => {
    const mapped = mapEvent(baseEvent({ support_artists: 'Stereolab, Cat Power' }));
    expect(mapped.concert.supporting_artists_raw).toEqual(['Stereolab', 'Cat Power']);
  });
});

describe('mapEvent — status and prices', () => {
  it.each([
    ['on_sale', 'on_sale'],
    ['sold_out', 'sold_out'],
    ['cancelled', 'cancelled'],
  ])('maps source status %s to %s unchanged', (source, expected) => {
    const mapped = mapEvent(baseEvent({ status: source }));
    expect(mapped.concert.status).toBe(expected);
  });

  it('maps free to on_sale with price_min defaulted to 0', () => {
    const mapped = mapEvent(baseEvent({ status: 'free', price_min: null, price_max: null }));
    expect(mapped.concert.status).toBe('on_sale');
    expect(mapped.concert.price_min).toBe('0.00');
    expect(mapped.concert.price_max).toBeNull();
  });

  it('preserves an explicit price_min on a free event', () => {
    const mapped = mapEvent(baseEvent({ status: 'free', price_min: 5 }));
    expect(mapped.concert.status).toBe('on_sale');
    expect(mapped.concert.price_min).toBe('5.00');
  });

  it('throws on a status outside the source enum (complete mapping; drift fails loudly)', () => {
    expect(() => mapEvent(baseEvent({ status: 'postponed' }))).toThrow(/status/);
  });

  it('carries float prices as 2-decimal numeric strings', () => {
    const mapped = mapEvent(baseEvent({ price_min: 15.5, price_max: 20 }));
    expect(mapped.concert.price_min).toBe('15.50');
    expect(mapped.concert.price_max).toBe('20.00');
  });
});

describe('mapEvent — tombstones and raw payload', () => {
  it('carries removed_at as a Date when the source tombstoned the event', () => {
    const mapped = mapEvent(baseEvent({ removed_at: '2026-07-01T10:00:00+00:00' }));
    expect(mapped.concert.removed_at).toEqual(new Date('2026-07-01T10:00:00Z'));
  });

  it('carries removed_at as NULL for live rows (writer clears on reappearance)', () => {
    const mapped = mapEvent(baseEvent({ removed_at: null }));
    expect(mapped.concert.removed_at).toBeNull();
  });

  it('stores the full EventResponse as raw_data (genre/subgenre/description live only there per Decision 2)', () => {
    const event = baseEvent({ genre: 'jazz', description: 'trio set' });
    const mapped = mapEvent(event);
    expect(mapped.concert.raw_data).toEqual(event);
  });

  it('passes age_restriction, ticket_url, image_url through', () => {
    const mapped = mapEvent(baseEvent({ age_restriction: '18+', ticket_url: 'https://t', image_url: 'https://i' }));
    expect(mapped.concert.age_restriction).toBe('18+');
    expect(mapped.concert.ticket_url).toBe('https://t');
    expect(mapped.concert.image_url).toBe('https://i');
  });
});

describe('backdatedStart', () => {
  // The shipped /api/v1/events contract: the default start=today window
  // hides a tombstone stamped on the event's own show date, and rows
  // hard-delete 7 days past their date — mirror consumers must back-date
  // `start` (8 days covers the full tombstone-observable window).
  it('returns the NY calendar date 8 days before the given instant', () => {
    expect(backdatedStart(new Date('2026-07-10T12:00:00Z'))).toBe('2026-07-02');
  });

  it('crosses month boundaries on the NY calendar, not UTC', () => {
    // 01:30Z on Aug 8 is Aug 7 in NY; 8 days back from Aug 7 is Jul 30.
    expect(backdatedStart(new Date('2026-08-08T01:30:00Z'))).toBe('2026-07-30');
  });
});
