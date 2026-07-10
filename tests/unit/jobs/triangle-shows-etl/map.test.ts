/**
 * Unit tests for the triangle-shows ETL's pure event -> concerts-row
 * mapping (BS#1589 field table). No DB, no network — `mapEvent` and its
 * helpers are pure, so the whole contract pins here.
 */
import {
  clampCodePoints,
  mapEvent,
  splitSupportArtists,
  backdatedStart,
} from '../../../../jobs/triangle-shows-etl/map';
import { makeTsEvent } from './fixtures';

describe('clampCodePoints', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(clampCodePoints(`${'x'.repeat(3)}🎸y`, 4)).toBe('xxx🎸');
    expect(clampCodePoints('short', 10)).toBe('short');
  });
});

describe('mapEvent — keying', () => {
  // The venue qualifier is load-bearing (BS#1589 "Keying"): triangle-shows
  // uniqueness is per-venue `(venue_id, source_key)` — its README's
  // uniqueness paragraph is explicit that `source_key` ALONE is not unique
  // (VenuePilot external ids are small integers that collide across
  // venues). Keying on bare source_key would fold distinct venues'
  // concerts into one row via the (source, source_id) unique index.
  it('composes source_id as venue_slug + ":" + source_key', () => {
    const mapped = mapEvent(makeTsEvent());
    expect(mapped.concert.source_id).toBe('the-pinhook:ext:12345');
    expect(mapped.concert.source).toBe('triangle_shows');
  });

  it('keeps a cross-venue same-source_key collision pair distinct', () => {
    const a = mapEvent(makeTsEvent({ venue_slug: 'rubies', source_key: 'ext:123' }));
    const b = mapEvent(makeTsEvent({ venue_slug: 'stancyks', source_key: 'ext:123' }));
    expect(a.concert.source_id).toBe('rubies:ext:123');
    expect(b.concert.source_id).toBe('stancyks:ext:123');
    expect(a.concert.source_id).not.toBe(b.concert.source_id);
  });

  it('throws on a missing venue_slug (cannot key without the qualifier)', () => {
    expect(() => mapEvent(makeTsEvent({ venue_slug: null }))).toThrow(/venue_slug/);
  });
});

describe('mapEvent — dates and times', () => {
  it('maps date to starts_on and composes starts_at from date + show_time in America/New_York', () => {
    const mapped = mapEvent(makeTsEvent({ show_time: '20:00:00' }));
    expect(mapped.concert.starts_on).toBe('2026-08-14');
    // 20:00 EDT == 00:00Z next day.
    expect(mapped.concert.starts_at?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('leaves starts_at NULL for date-only events (no fabricated times)', () => {
    const mapped = mapEvent(makeTsEvent({ show_time: null, doors_time: null }));
    expect(mapped.concert.starts_on).toBe('2026-08-14');
    expect(mapped.concert.starts_at).toBeNull();
    expect(mapped.concert.doors_at).toBeNull();
  });

  it('composes doors_at from doors_time independently of show_time', () => {
    const mapped = mapEvent(makeTsEvent({ doors_time: '19:00:00', show_time: null }));
    expect(mapped.concert.doors_at?.toISOString()).toBe('2026-08-14T23:00:00.000Z');
    expect(mapped.concert.starts_at).toBeNull();
  });

  it('uses the EST offset for winter dates', () => {
    const mapped = mapEvent(makeTsEvent({ date: '2026-12-04', show_time: '20:00:00' }));
    expect(mapped.concert.starts_on).toBe('2026-12-04');
    expect(mapped.concert.starts_at?.toISOString()).toBe('2026-12-05T01:00:00.000Z');
  });

  // Both branches must fail as MAP errors: for timed events nyWallClockToUtc
  // validates the date, but date-only events pass event.date straight to the
  // starts_on date column — without map-time validation a source date-format
  // drift would surface as opaque upsert_errors and misdirect triage at the
  // write path (the README documents map_errors as the contract-drift signal).
  it.each([
    ['date-only', null],
    ['timed', '20:00:00'],
  ])('throws a map error on a non-ISO date for %s events', (_label, show_time) => {
    expect(() => mapEvent(makeTsEvent({ date: '08/14/2026', show_time }))).toThrow(/date/);
  });
});

describe('mapEvent — headliner and title', () => {
  it('prefers artist over name for headlining_artist_raw and carries name as title', () => {
    const mapped = mapEvent(makeTsEvent({ artist: 'Juana Molina', name: 'Juana Molina — DOGA tour' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Juana Molina');
    expect(mapped.concert.title).toBe('Juana Molina — DOGA tour');
  });

  it('falls back to name when artist is null (name is NOT NULL at the source, so the mapping is total)', () => {
    const mapped = mapEvent(makeTsEvent({ artist: null, name: 'Duke Ellington & John Coltrane' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Duke Ellington & John Coltrane');
  });

  // `||` on the trimmed artist, not `??`: heterogeneous scrapers can emit ''
  // where they mean "unknown"; an empty NOT NULL headliner defeats both the
  // resolver and any display while the recoverable name sits right there.
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('falls back to name when artist is %s', (_label, artist) => {
    const mapped = mapEvent(makeTsEvent({ artist, name: 'Chuquimamani-Condori' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Chuquimamani-Condori');
  });

  it('truncates headlining_artist_raw to 256 (source String(500) vs concerts varchar(256))', () => {
    const long = 'x'.repeat(500);
    const mapped = mapEvent(makeTsEvent({ artist: long }));
    expect(mapped.concert.headlining_artist_raw).toHaveLength(256);
    expect(mapped.concert.headlining_artist_raw).toBe(long.slice(0, 256));
  });

  it('truncates by code points, never stranding half a surrogate pair', () => {
    // 255 ASCII chars then an astral (2-code-unit) character: a UTF-16
    // code-unit slice would cut the pair in half and postgres-js would
    // store U+FFFD. The clamp counts code points, so the char survives.
    const mapped = mapEvent(makeTsEvent({ artist: `${'x'.repeat(255)}🎸trailing` }));
    const raw = mapped.concert.headlining_artist_raw;
    expect([...raw]).toHaveLength(256);
    expect(raw.endsWith('🎸')).toBe(true);
    expect(raw).not.toContain('�');
  });
});

describe('splitSupportArtists', () => {
  it.each([
    [null, []],
    ['', []],
    ['Chuquimamani-Condori', ['Chuquimamani-Condori']],
    ['Stereolab, Cat Power', ['Stereolab', 'Cat Power']],
    // Internal empty element and padding whitespace both dropped.
    ['Juana Molina, , Jessica Pratt', ['Juana Molina', 'Jessica Pratt']],
    ['  Nilüfer Yanya ,Hermanos Gutiérrez  ', ['Nilüfer Yanya', 'Hermanos Gutiérrez']],
  ])('splitSupportArtists(%j) -> %j', (input, expected) => {
    expect(splitSupportArtists(input)).toEqual(expected);
  });

  it('is what mapEvent feeds supporting_artists_raw', () => {
    const mapped = mapEvent(makeTsEvent({ support_artists: 'Stereolab, Cat Power' }));
    expect(mapped.concert.supporting_artists_raw).toEqual(['Stereolab', 'Cat Power']);
  });
});

describe('mapEvent — status and prices', () => {
  it.each([
    ['on_sale', 'on_sale'],
    ['sold_out', 'sold_out'],
    ['cancelled', 'cancelled'],
  ])('maps source status %s to %s unchanged', (source, expected) => {
    const mapped = mapEvent(makeTsEvent({ status: source }));
    expect(mapped.concert.status).toBe(expected);
  });

  it('maps free to on_sale with price_min defaulted to 0', () => {
    const mapped = mapEvent(makeTsEvent({ status: 'free', price_min: null, price_max: null }));
    expect(mapped.concert.status).toBe('on_sale');
    expect(mapped.concert.price_min).toBe('0.00');
    expect(mapped.concert.price_max).toBeNull();
  });

  it('preserves an explicit price_min on a free event', () => {
    const mapped = mapEvent(makeTsEvent({ status: 'free', price_min: 5 }));
    expect(mapped.concert.status).toBe('on_sale');
    expect(mapped.concert.price_min).toBe('5.00');
  });

  it('throws on a status outside the source enum (complete mapping; drift fails loudly)', () => {
    expect(() => mapEvent(makeTsEvent({ status: 'postponed' }))).toThrow(/status/);
  });

  it('carries float prices as 2-decimal numeric strings', () => {
    const mapped = mapEvent(makeTsEvent({ price_min: 15.5, price_max: 20 }));
    expect(mapped.concert.price_min).toBe('15.50');
    expect(mapped.concert.price_max).toBe('20.00');
  });
});

describe('mapEvent — tombstones and raw payload', () => {
  it('carries removed_at as a Date when the source tombstoned the event', () => {
    const mapped = mapEvent(makeTsEvent({ removed_at: '2026-07-01T10:00:00+00:00' }));
    expect(mapped.concert.removed_at).toEqual(new Date('2026-07-01T10:00:00Z'));
  });

  it('carries removed_at as NULL for live rows (writer clears on reappearance)', () => {
    const mapped = mapEvent(makeTsEvent({ removed_at: null }));
    expect(mapped.concert.removed_at).toBeNull();
  });

  it('stores the full EventResponse as raw_data (genre/subgenre/description live only there per Decision 2)', () => {
    const event = makeTsEvent({ genre: 'jazz', description: 'trio set' });
    const mapped = mapEvent(event);
    expect(mapped.concert.raw_data).toEqual(event);
  });

  it('passes age_restriction, ticket_url, image_url through', () => {
    const mapped = mapEvent(makeTsEvent({ age_restriction: '18+', ticket_url: 'https://t', image_url: 'https://i' }));
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
