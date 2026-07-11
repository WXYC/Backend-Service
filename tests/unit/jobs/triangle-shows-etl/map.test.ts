/**
 * Unit tests for the triangle-shows ETL's pure event -> concerts-row
 * mapping (BS#1589 field table). No DB, no network — `mapEvent` and its
 * helpers are pure, so the whole contract pins here.
 */
import {
  clampCodePoints,
  extractHeadliner,
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
  it('prefers artist over name for headlining_artist_raw and carries name as title when distinct', () => {
    const mapped = mapEvent(makeTsEvent({ artist: 'Juana Molina', name: 'Juana Molina — DOGA tour' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Juana Molina');
    expect(mapped.concert.title).toBe('Juana Molina — DOGA tour');
  });

  // schema.ts documents title as 'Event name as the source displays it,
  // when distinct from the artist' (and rhp_scrape rows leave it NULL).
  // Writing name unconditionally would render 'Juana Molina — Juana
  // Molina' in any feed using the documented headliner—title shape.
  it('leaves title NULL when the headliner IS the name (artist absent — nothing distinct to display)', () => {
    const mapped = mapEvent(makeTsEvent({ artist: null, name: 'Jessica Pratt' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Jessica Pratt');
    expect(mapped.concert.title).toBeNull();
  });

  it('leaves title NULL when name and artist are the same string (not distinct billing)', () => {
    const mapped = mapEvent(makeTsEvent({ artist: 'Cat Power', name: 'Cat Power' }));
    expect(mapped.concert.title).toBeNull();
  });

  it('trims the name fallback so a padded source name cannot store a padded headliner', () => {
    const mapped = mapEvent(makeTsEvent({ artist: null, name: '  Cat Power  ' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Cat Power');
  });

  it('throws a map error when artist AND name are both blank — a headliner-less row satisfies NOT NULL but is unresolvable garbage', () => {
    expect(() => mapEvent(makeTsEvent({ artist: null, name: '   ' }))).toThrow(/blank/i);
    expect(() => mapEvent(makeTsEvent({ artist: ' ', name: '' }))).toThrow(/blank/i);
  });

  it('leaves title NULL when name is blank but artist is valid — a whitespace title is not "distinct billing"', () => {
    const mapped = mapEvent(makeTsEvent({ artist: 'Cat Power', name: '   ' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Cat Power');
    expect(mapped.concert.title).toBeNull();
  });

  it('keeps the full name in title exactly when truncation amputated the headliner (artist absent, name past 256 code points)', () => {
    const long = `${'x'.repeat(300)}`;
    const mapped = mapEvent(makeTsEvent({ artist: null, name: long }));
    expect([...mapped.concert.headlining_artist_raw]).toHaveLength(256);
    // Without this, the amputated prefix would be the only queryable copy.
    expect(mapped.concert.title).toBe(long);
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

// BS#1604: the source's `artist` is the full marquee/billing string in
// practice (byte-identical to `name` 550/550), which starves the exact-
// match concerts-artist-resolver. extractHeadliner derives a clean
// headliner; the contract is CONSERVATIVE — under-strip over over-strip,
// because a dirty billing merely stays unresolved while an over-stripped
// one can resolve to the WRONG artist.
describe('extractHeadliner — strip patterns', () => {
  it.each([
    // Leading tag-shaped parentheticals/brackets, incl. repeated.
    ['(Record Shop) Gracie Abrams Listening Party', 'Gracie Abrams Listening Party'],
    ['(LOW TIX) (18+) Deerhoof', 'Deerhoof'],
    ['(SOLD OUT) Jessica Pratt', 'Jessica Pratt'],
    ['[MOVED TO THE RITZ] Stereolab', 'Stereolab'],
    // Framing prefixes, with and without the colon for An Evening With.
    ['An Evening With: Mountain Grass Unit', 'Mountain Grass Unit'],
    ['An Evening With Juana Molina', 'Juana Molina'],
    ["Cat's Cradle Presents: Hiss Golden Messenger", 'Hiss Golden Messenger'],
    // Support-act tails.
    ["Acid Mother's Temple w/ Magick Potion", "Acid Mother's Temple"],
    ['76th Street w/ Tornsey', '76th Street'],
    ['76th Street w/Tornsey', '76th Street'], // no space after the token occurs in the wild
    ['Wednesday W/ Truth Club', 'Wednesday'], // case-insensitive
    ['Horse Jumper of Love // Squirrel Flower // Sluice', 'Horse Jumper of Love'],
    ['Mdou Moctar feat. Mikey Coltun', 'Mdou Moctar'],
    ['Mdou Moctar ft. Mikey Coltun', 'Mdou Moctar'],
    ['Mdou Moctar featuring Mikey Coltun', 'Mdou Moctar'],
    // Stacked structures strip to a fixpoint, and a tail strip cleans up
    // punctuation it leaves dangling.
    ['(LOW TIX) An Evening With: Deerhoof w/ Sword II', 'Deerhoof'],
    ['Deerhoof - w/ Sword II', 'Deerhoof'],
  ])('extractHeadliner(%j) -> %j', (input, expected) => {
    expect(extractHeadliner(input)).toBe(expected);
  });
});

describe('extractHeadliner — conservative negatives (must NOT strip)', () => {
  it.each([
    // `&` / `and` / `with` / `+` are never support delimiters.
    'Andy Frasco & The U.N',
    'Duke Ellington & John Coltrane',
    'Iron and Wine',
    'Elvis Costello with Steve Nieve',
    'Sylvan Esso + Flock of Dimes',
    // A single mixed-case leading parenthetical word is plausibly part of
    // the name — only tag-shaped parentheticals (multi-word, digits,
    // all-caps) strip.
    '(Sandy) Alex G',
    // Trailing parentheticals are part of the name; only LEADING tags strip.
    '!!! (Chk Chk Chk)',
    'Owen (solo)',
    // Slash-bearing names: delimiters require leading whitespace.
    'AC/DC',
    'DIIV/Horsegirl', // no whitespace around the slash — not a ` // ` tail
    // Word-shaped delimiters require both-sides whitespace / the dot.
    'Featherweight',
    'The Weather Station',
  ])('extractHeadliner(%j) is the identity', (input) => {
    expect(extractHeadliner(input)).toBe(input);
  });
});

describe('extractHeadliner — fallback and idempotence', () => {
  it.each([
    // Cleanup that empties the string falls back to the full billing —
    // better stored verbatim (it just stays unresolved, like today) than
    // dropped or blanked.
    ['(SOLD OUT)', '(SOLD OUT)'],
    ['(18+)', '(18+)'],
    ['An Evening With:', 'An Evening With:'],
  ])('falls back to the full billing when cleanup empties it: %j', (input, expected) => {
    expect(extractHeadliner(input)).toBe(expected);
  });

  it('trims whitespace even on the fallback path', () => {
    expect(extractHeadliner('   ')).toBe('');
    expect(extractHeadliner('  Jessica Pratt  ')).toBe('Jessica Pratt');
  });

  it.each([
    "Acid Mother's Temple w/ Magick Potion",
    '(LOW TIX) (18+) An Evening With: Deerhoof w/ Sword II',
    '(Record Shop) Gracie Abrams Listening Party',
    '(SOLD OUT)',
    'An Evening With:',
    'Andy Frasco & The U.N',
    '(Sandy) Alex G',
    'Horse Jumper of Love // Squirrel Flower',
  ])('is idempotent: extract(extract(%j)) === extract(%j)', (input) => {
    const once = extractHeadliner(input);
    expect(extractHeadliner(once)).toBe(once);
  });
});

describe('mapEvent — clean headliner wiring (BS#1604)', () => {
  it('cleans the billing into headlining_artist_raw while title keeps the full display billing', () => {
    // The 550/550 case: artist byte-identical to name, both the full billing.
    const billing = "Acid Mother's Temple w/ Magick Potion";
    const mapped = mapEvent(makeTsEvent({ artist: billing, name: billing }));
    expect(mapped.concert.headlining_artist_raw).toBe("Acid Mother's Temple");
    expect(mapped.concert.title).toBe(billing);
  });

  it('leaves title NULL when no cleanup fires and artist === name (no behavior change)', () => {
    const mapped = mapEvent(makeTsEvent({ artist: 'Cat Power', name: 'Cat Power' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Cat Power');
    expect(mapped.concert.title).toBeNull();
  });

  it('prefers a present, non-blank upstream headliner field and skips the heuristic', () => {
    const billing = '(An Oddly Tagged) Billing w/ Support';
    const mapped = mapEvent(makeTsEvent({ headliner: 'Acid Mothers Temple', artist: billing, name: billing }));
    expect(mapped.concert.headlining_artist_raw).toBe('Acid Mothers Temple');
    expect(mapped.concert.title).toBe(billing);
  });

  it('trims the upstream headliner before use', () => {
    const mapped = mapEvent(makeTsEvent({ headliner: '  Deerhoof  ' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Deerhoof');
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['absent (pre-upstream payloads omit the key)', undefined],
  ])('falls back to the heuristic when the upstream headliner is %s', (_label, headliner) => {
    const mapped = mapEvent(makeTsEvent({ headliner, artist: '76th Street w/ Tornsey' }));
    expect(mapped.concert.headlining_artist_raw).toBe('76th Street');
  });

  it('clamps the upstream headliner to 256 code points like every other route', () => {
    const mapped = mapEvent(makeTsEvent({ headliner: 'x'.repeat(500) }));
    expect(mapped.concert.headlining_artist_raw).toHaveLength(256);
  });

  it('still throws a map error when headliner, artist AND name are all blank', () => {
    expect(() => mapEvent(makeTsEvent({ headliner: ' ', artist: null, name: '   ' }))).toThrow(/blank/i);
  });

  it('writes the row on a blank billing when the upstream headliner carries the name', () => {
    const mapped = mapEvent(makeTsEvent({ headliner: 'Deerhoof', artist: null, name: '  ' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Deerhoof');
    expect(mapped.concert.title).toBeNull();
  });

  it('strips U+0000 before extraction so the heuristic sees the sanitized billing', () => {
    const mapped = mapEvent(makeTsEvent({ artist: 'Nil\u0000üfer Yanya w/ Truth Club' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Nilüfer Yanya');
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

  // numeric(8,2) caps at 999999.99 and PG errors rather than truncates.
  // Source floats are unbounded, and the scrapers' price regexes can
  // misparse prose digit runs (a phone number in a Squarespace
  // description) — an un-storable price must drop to NULL, not fail the
  // whole event's upsert every night.
  it('drops un-storable prices (past the numeric(8,2) cap) instead of failing the event', () => {
    const mapped = mapEvent(makeTsEvent({ price_min: 9195551234, price_max: 20242025 }));
    expect(mapped.concert.price_min).toBeNull();
    expect(mapped.concert.price_max).toBeNull();
  });

  it('judges the cap on the ROUNDED value — toFixed carries 999999.996 to 1000000.00', () => {
    expect(mapEvent(makeTsEvent({ price_min: 999999.99 })).concert.price_min).toBe('999999.99');
    expect(mapEvent(makeTsEvent({ price_min: 999999.996 })).concert.price_min).toBeNull();
    expect(mapEvent(makeTsEvent({ price_min: Number.POSITIVE_INFINITY })).concert.price_min).toBeNull();
  });

  it('drops negative prices — the same misparse family can capture a leading hyphen from prose ranges', () => {
    expect(mapEvent(makeTsEvent({ price_min: -5 })).concert.price_min).toBeNull();
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

  it('throws a map error on an unparseable removed_at — an Invalid Date would otherwise explode at the Drizzle bind as a context-free RangeError counted as an upsert_error', () => {
    expect(() => mapEvent(makeTsEvent({ removed_at: 'not-a-timestamp' }))).toThrow(/removed_at/);
  });

  it('strips U+0000 from the raw payload — PG rejects NUL in every text-typed bind, which would permanently fail the event', () => {
    const mapped = mapEvent(makeTsEvent({ description: 'trio\u0000set' }));
    expect((mapped.concert.raw_data as { description: string }).description).toBe('trioset');
  });

  it('strips U+0000 from mapped columns too, not just raw_data — a NUL in artist would fail the varchar bind the same way', () => {
    const mapped = mapEvent(makeTsEvent({ artist: 'Nil\u0000üfer Yanya' }));
    expect(mapped.concert.headlining_artist_raw).toBe('Nilüfer Yanya');
  });

  it('passes a clean payload through as the same object (no needless deep copy)', () => {
    const event = makeTsEvent({ description: 'trio set' });
    expect(mapEvent(event).concert.raw_data).toBe(event);
  });

  it('does not corrupt literal backslash-u0000 TEXT (no actual NUL) — escaped-JSON string surgery would strip the escape and break or mangle the payload', () => {
    // The 6 typed characters backslash-u-0-0-0-0, not a control character.
    const event = makeTsEvent({ description: 'call \\u0000 me' });
    const mapped = mapEvent(event);
    expect(mapped.concert.raw_data).toBe(event);
    expect((mapped.concert.raw_data as { description: string }).description).toBe('call \\u0000 me');
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
