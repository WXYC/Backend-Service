/**
 * Unit tests for the RHP venue HTML parser.
 *
 * Strategy: use saved real-world fixture HTML from Cat's Cradle. The
 * fixtures contain the actual schema.org Event JSON-LD block emitted by
 * the Rockhouse Partners WordPress plugin (verified via curl on
 * 2026-06-04). When RHP changes their HTML, these tests fail loudly so we
 * notice before the cron silently stops producing rows.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  decodeHtmlEntities,
  extractEventJsonLd,
  extractEventLinks,
  extractSupportingActsFromEtix,
  parseEventPage,
  resolveVenueSlug,
} from '../../../../jobs/venue-events-scraper/parse';
import { RHP_SITES } from '../../../../jobs/venue-events-scraper/rhp-venues';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/venue-events-scraper');
const readFixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

const CATS_CRADLE = RHP_SITES.find((s) => s.site_slug === 'cats-cradle');
if (!CATS_CRADLE) throw new Error('test setup: cats-cradle venue config missing from RHP_SITES');

describe('decodeHtmlEntities', () => {
  it.each([
    ['Cat&#039;s Cradle', "Cat's Cradle"],
    ['Cat&#8217;s Cradle', 'Cat’s Cradle'],
    ['Earth, Wind &amp; Fire', 'Earth, Wind & Fire'],
    ['Sinéad O&apos;Connor', "Sinéad O'Connor"],
    ['quotes &quot;in&quot; text', 'quotes "in" text'],
    ['no entities here', 'no entities here'],
    ['', ''],
  ])('decodes %p → %p', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it('returns empty string for null/undefined (defensive)', () => {
    expect(decodeHtmlEntities(null)).toBe('');
    expect(decodeHtmlEntities(undefined)).toBe('');
  });

  it('leaves unknown entities literally rather than mangling', () => {
    // Conservative decoder: we'd rather ship "&#x2603;" than guess wrong.
    expect(decodeHtmlEntities('snowman: &#x2603; here')).toBe('snowman: &#x2603; here');
  });
});

describe('extractEventLinks', () => {
  const BASE = 'https://catscradle.com';

  it('finds all /event/<slug>/ URLs in the events index', () => {
    const html = readFixture('cats-cradle-events-index.html');
    const links = extractEventLinks(html, BASE);
    expect(links).toContain('https://catscradle.com/event/aaron-lee-tasjan-2/');
    expect(links).toContain('https://catscradle.com/event/sleater-kinney/');
    expect(links).toContain('https://catscradle.com/event/the-headliner/');
  });

  it('deduplicates repeat links (same event shown in featured + list)', () => {
    const html = readFixture('cats-cradle-events-index.html');
    const links = extractEventLinks(html, BASE);
    const aaron = links.filter((u) => u.includes('aaron-lee-tasjan-2'));
    expect(aaron).toHaveLength(1);
  });

  it('ignores non-event links (/about/, /contact/)', () => {
    const html = readFixture('cats-cradle-events-index.html');
    const links = extractEventLinks(html, BASE);
    expect(links.every((u) => u.includes('/event/'))).toBe(true);
  });

  it('returns empty array when the index has no event links', () => {
    expect(extractEventLinks('<html><body>nothing here</body></html>', BASE)).toEqual([]);
  });

  it('drops cross-origin /event/<slug>/ links (sister-venue / partner cross-promo)', () => {
    // Cat's Cradle index containing a footer/sidebar link to a sister
    // venue must not pull that venue's event into the cats-cradle loop.
    const html = `
      <a href="https://catscradle.com/event/local-act/">Local</a>
      <a href="https://local506.com/event/cross-promo/">Cross-promo</a>
      <a href='https://example.com/event/junk/'>Other</a>
    `;
    const links = extractEventLinks(html, BASE);
    expect(links).toEqual(['https://catscradle.com/event/local-act/']);
  });

  it('strips query strings + fragments before normalizing trailing slash', () => {
    // Without the strip, `replace(/\\/?$/, '/')` would turn
    // `…/the-band?ref=homepage` into `…/the-band?ref=homepage/` and the
    // subsequent fetch 404s.
    const html = `
      <a href="https://catscradle.com/event/the-band?ref=homepage">A</a>
      <a href="https://catscradle.com/event/other-band/#tickets">B</a>
    `;
    const links = extractEventLinks(html, BASE);
    expect(links).toContain('https://catscradle.com/event/the-band/');
    expect(links).toContain('https://catscradle.com/event/other-band/');
  });

  it('accepts slugs with uppercase / underscore (no silent drop)', () => {
    // The legacy `[a-z0-9-]+` regex silently skipped these and emitted
    // no log line — a future RHP slug-format change would have produced
    // missing concerts without diagnostics.
    const html = `
      <a href="https://catscradle.com/event/Sleater_Kinney/">A</a>
      <a href="https://catscradle.com/event/Mixed-Case-Slug/">B</a>
    `;
    const links = extractEventLinks(html, BASE);
    expect(links).toContain('https://catscradle.com/event/Sleater_Kinney/');
    expect(links).toContain('https://catscradle.com/event/Mixed-Case-Slug/');
  });

  it('does NOT match data-href= / aria-href= attributes (SPA hover-preview noise)', () => {
    // RHP themes use `data-href` for hover-preview SPA links; the
    // legacy regex matched bare `href=` anywhere in the source string,
    // including inside `data-href` / `aria-href` attribute names, and
    // pulled in duplicate / staging URLs that 404 on fetch.
    const html = `
      <div data-href="https://catscradle.com/event/preview-only/">Preview</div>
      <span aria-href="https://catscradle.com/event/aria-only/">Aria</span>
      <a href="https://catscradle.com/event/real-link/">Real</a>
    `;
    const links = extractEventLinks(html, BASE);
    expect(links).toEqual(['https://catscradle.com/event/real-link/']);
  });
});

describe('extractEventJsonLd', () => {
  it('parses the Event block from a Cat’s Cradle event page', () => {
    const html = readFixture('cats-cradle-aaron-lee-tasjan.html');
    const event = extractEventJsonLd(html);
    if (event === null) throw new Error('expected Event JSON-LD to parse');
    expect(event.name).toBe('Aaron Lee Tasjan');
    expect(event.startDate).toBe('2026-11-06T20:00:00-0500');
    expect(event.location?.name).toBe('Cat&#8217;s Cradle Back Room');
  });

  it('returns null when the Event-marker comment is absent (likely 404 page)', () => {
    const html = readFixture('cats-cradle-no-event-block.html');
    expect(extractEventJsonLd(html)).toBeNull();
  });

  it('does NOT pick up the venue-level rank-math schema as the event', () => {
    // The fixture contains both a rank-math Place schema AND the Event
    // block — make sure we get the Event, not the Place.
    const html = readFixture('cats-cradle-aaron-lee-tasjan.html');
    const event = extractEventJsonLd(html);
    if (event === null) throw new Error('expected Event JSON-LD to parse');
    expect(event['@type']).toBe('Event');
  });

  it('throws on a malformed JSON-LD block (loud failure for source drift)', () => {
    const html = '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{not json}</script>';
    expect(() => extractEventJsonLd(html)).toThrow();
  });

  it('throws when the parsed block is not an Event (@type drift)', () => {
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Article","name":"oops"}</script>';
    expect(() => extractEventJsonLd(html)).toThrow(/unexpected @type/);
  });

  it('accepts @type=MusicEvent (schema.org subtype RHP may emit for music shows)', () => {
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"MusicEvent","name":"Test","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"Test Venue"}}</script>';
    const event = extractEventJsonLd(html);
    if (event === null) throw new Error('expected MusicEvent JSON-LD to parse');
    expect(event['@type']).toBe('MusicEvent');
  });

  it('accepts @type as an array (schema.org multi-typing pattern)', () => {
    // `["Event","MusicEvent"]` is valid schema.org JSON-LD — common when
    // a publisher wants to claim both the parent type and the subtype.
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":["Event","MusicEvent"],"name":"Test","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"Test Venue"}}</script>';
    const event = extractEventJsonLd(html);
    if (event === null) throw new Error('expected multi-typed Event JSON-LD to parse');
    expect(Array.isArray(event['@type'])).toBe(true);
  });
});

describe('extractSupportingActsFromEtix', () => {
  it("recovers a single support act from Cat's Cradle's Etix slug", () => {
    const url =
      'https://www.etix.com/ticket/p/79604526/aaron-lee-tasjanwith-madeleine-kelson-carrboro-cats-cradle-back-room?partner_id=100';
    expect(extractSupportingActsFromEtix(url, 'Aaron Lee Tasjan')).toEqual(['Madeleine Kelson']);
  });

  it('recovers multiple support acts', () => {
    const url =
      'https://www.etix.com/ticket/p/99999/the-headlinerwith-first-supportwith-second-support-carrboro-cats-cradle?partner_id=100';
    expect(extractSupportingActsFromEtix(url, 'The Headliner')).toEqual(['First Support', 'Second Support']);
  });

  it('returns [] for a headliner-only Etix slug (no with- separator)', () => {
    const url = 'https://www.etix.com/ticket/p/12345678/sleater-kinney-carrboro-cats-cradle?partner_id=100';
    expect(extractSupportingActsFromEtix(url, 'Sleater-Kinney')).toEqual([]);
  });

  it('returns [] for a non-Etix ticket URL', () => {
    expect(extractSupportingActsFromEtix('https://www.ticketmaster.com/event/abc', 'Anyone')).toEqual([]);
  });

  it('returns [] for null/undefined/empty input', () => {
    expect(extractSupportingActsFromEtix(null)).toEqual([]);
    expect(extractSupportingActsFromEtix(undefined)).toEqual([]);
    expect(extractSupportingActsFromEtix('')).toEqual([]);
  });

  it('returns [] for a malformed URL', () => {
    expect(extractSupportingActsFromEtix('not a url at all')).toEqual([]);
  });

  it('does NOT mis-split when the headliner name contains "with" as a word', () => {
    // Regression for the substring-split bug: splitting on the literal
    // `with-` substring inside a headliner like "Out With My Friends"
    // would yield ['out-', 'my-friends', 'X-...'] and ship phantom
    // support ['My Friends','X'] when the real support is just ['X'].
    const url =
      'https://www.etix.com/ticket/p/55555/out-with-my-friendswith-real-support-carrboro-cats-cradle?partner_id=100';
    expect(extractSupportingActsFromEtix(url, 'Out With My Friends')).toEqual(['Real Support']);
  });

  it('does NOT mis-split a single-act bill whose headliner contains "with"', () => {
    const url = 'https://www.etix.com/ticket/p/55555/out-with-my-friends-carrboro-cats-cradle?partner_id=100';
    expect(extractSupportingActsFromEtix(url, 'Out With My Friends')).toEqual([]);
  });

  it('falls back to legacy split when no headliner is passed (back-compat)', () => {
    const url =
      'https://www.etix.com/ticket/p/79604526/aaron-lee-tasjanwith-madeleine-kelson-carrboro-cats-cradle-back-room?partner_id=100';
    expect(extractSupportingActsFromEtix(url)).toEqual(['Madeleine Kelson']);
  });

  it('extracts the support act for a non-ASCII headliner (regression: NFKD slug fold)', () => {
    // `slugifyGeneric('Sigur Rós')` must produce 'sigur-ros' (matching
    // the Etix URL slug) — not 'sigur-r-s' (which the legacy
    // ASCII-strip produced, dropping the prefix match and silently
    // falling back to the legacy buggy split).
    const url = 'https://www.etix.com/ticket/p/12345/sigur-roswith-real-support-carrboro-cats-cradle?partner_id=100';
    expect(extractSupportingActsFromEtix(url, 'Sigur Rós')).toEqual(['Real Support']);
  });

  it('does NOT mis-match a short common-word headliner against a longer URL slug (regression: prefix word boundary)', () => {
    // Headliner 'Big' must not accidentally match `big-thiefwith-…`:
    // before the word-boundary fix, the headliner-anchored branch saw
    // remainder='-thiefwith-…', failed the `with-` check, and returned
    // [] without falling back — silently dropping the real support.
    const url = 'https://www.etix.com/ticket/p/55555/big-thiefwith-real-support-carrboro-cats-cradle?partner_id=100';
    expect(extractSupportingActsFromEtix(url, 'Big')).toEqual(['Real Support']);
  });

  it('strips a Raleigh city/venue tail (regression: iter-3 dropped raleigh when CITY_TOKENS was derived from VENUE_SEEDS)', () => {
    // Cat's Cradle Presents co-promoted at a Raleigh venue (e.g. Lincoln
    // Theatre) — the Etix slug carries `-raleigh-<venue>` even though
    // VENUE_SEEDS doesn't host a Raleigh seed. CITY_TOKENS must keep
    // raleigh as a baseline city, else the trailing city/venue chunk
    // gets concatenated into the support-act name.
    const url = 'https://www.etix.com/ticket/p/77/the-bandwith-real-support-raleigh-lincoln-theatre?partner_id=100';
    expect(extractSupportingActsFromEtix(url, 'The Band')).toEqual(['Real Support']);
  });

  it.each([
    // Non-decomposable Latin letters NFKD treats as atomic — without the
    // explicit transliteration map these would slugify to lossy forms
    // (e.g. 'Mø' → 'm', 'Łódź' → 'odz') and the headliner-prefix match
    // would silently fall back to the legacy buggy split.
    [
      'Mø',
      'https://www.etix.com/ticket/p/77/mowith-real-support-carrboro-cats-cradle?partner_id=100',
      ['Real Support'],
    ],
    [
      'Sigur Roß',
      'https://www.etix.com/ticket/p/77/sigur-rosswith-real-support-carrboro-cats-cradle?partner_id=100',
      ['Real Support'],
    ],
    [
      'Łukasz',
      'https://www.etix.com/ticket/p/77/lukaszwith-real-support-carrboro-cats-cradle?partner_id=100',
      ['Real Support'],
    ],
  ])('handles non-decomposable headliner %p without falling back to the buggy legacy split', (name, url, expected) => {
    expect(extractSupportingActsFromEtix(url, name)).toEqual(expected);
  });
});

describe('resolveVenueSlug', () => {
  it('maps known venue display names to their canonical slug', () => {
    expect(resolveVenueSlug(CATS_CRADLE, "Cat's Cradle")).toBe('cats-cradle');
    expect(resolveVenueSlug(CATS_CRADLE, "Cat's Cradle Back Room")).toBe('cats-cradle-back-room');
    expect(resolveVenueSlug(CATS_CRADLE, 'Haw River Ballroom')).toBe('haw-river-ballroom');
    expect(resolveVenueSlug(CATS_CRADLE, 'Motorco Music Hall')).toBe('motorco-music-hall');
  });

  it("handles curly-quote variants of the venue name (Cat's vs Cat’s)", () => {
    expect(resolveVenueSlug(CATS_CRADLE, 'Cat’s Cradle Back Room')).toBe('cats-cradle-back-room');
  });

  it('falls back to the site default slug when display name is null', () => {
    expect(resolveVenueSlug(CATS_CRADLE, null)).toBe('cats-cradle');
  });

  it('generically slugifies unknown venue names', () => {
    expect(resolveVenueSlug(CATS_CRADLE, 'New Venue 506')).toBe('new-venue-506');
  });
});

describe('parseEventPage', () => {
  it('returns a fully-populated ParsedConcert for the canonical Cat’s Cradle fixture', () => {
    const html = readFixture('cats-cradle-aaron-lee-tasjan.html');
    const url = 'https://catscradle.com/event/aaron-lee-tasjan-2/';
    const parsed = parseEventPage(CATS_CRADLE, url, html);
    if (parsed === null) throw new Error('expected canonical fixture to parse');

    expect(parsed).toMatchObject({
      site_slug: 'cats-cradle',
      source_id: 'cats-cradle:/event/aaron-lee-tasjan-2/',
      event_page_url: url,
      venue_slug: 'cats-cradle-back-room',
      venue_name: 'Cat’s Cradle Back Room',
      venue_address: '300 E Main St., Carrboro, North Carolina',
      headlining_artist: 'Aaron Lee Tasjan',
      supporting_artists: ['Madeleine Kelson'],
      starts_at: '2026-11-06T20:00:00-0500',
      ticket_url:
        'https://www.etix.com/ticket/p/79604526/aaron-lee-tasjanwith-madeleine-kelson-carrboro-cats-cradle-back-room?partner_id=100',
      image_url: 'https://catscradle.com/wp-content/uploads/2026/04/aaron-lee-tasjan.jfif',
    });
    expect(parsed.raw['@type']).toBe('Event');
  });

  it('returns null when the page has no Event block (likely a past/404 page)', () => {
    const html = readFixture('cats-cradle-no-event-block.html');
    const parsed = parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/old/', html);
    expect(parsed).toBeNull();
  });

  it('handles a headliner-only show (no support acts) without throwing', () => {
    const html = readFixture('cats-cradle-headliner-only.html');
    const parsed = parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/sleater-kinney/', html);
    if (parsed === null) throw new Error('expected fixture to parse');
    expect(parsed.headlining_artist).toBe('Sleater-Kinney');
    expect(parsed.supporting_artists).toEqual([]);
    expect(parsed.venue_slug).toBe('cats-cradle');
  });

  it('handles multi-support bills correctly', () => {
    const html = readFixture('cats-cradle-multi-support.html');
    const parsed = parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/the-headliner/', html);
    if (parsed === null) throw new Error('expected fixture to parse');
    expect(parsed.headlining_artist).toBe('The Headliner');
    expect(parsed.supporting_artists).toEqual(['First Support', 'Second Support']);
  });

  it('throws if Event.name is empty (source drift, fail loudly)', () => {
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"","startDate":"2026-01-01T20:00:00-0500"}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(/empty Event\.name/);
  });

  it('throws if Event.startDate is missing (source drift, fail loudly)', () => {
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X"}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(/missing Event\.startDate/);
  });

  it('throws if Event.startDate is unparseable as a Date (TBA / "August 15" etc.)', () => {
    // The ISO-8601 regex rejects non-ISO inputs before we even hand
    // them to `new Date()` — important because V8's legacy fallback
    // happily parses 'August 15' as a Date pinned to the current year,
    // letting format-drift junk through if we only checked Invalid Date.
    const tba =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X","startDate":"TBA","location":{"@type":"Place","name":"Cat\'s Cradle"}}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', tba)).toThrow(/non-ISO-8601 Event\.startDate/);
    const august =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X","startDate":"August 15","location":{"@type":"Place","name":"Cat\'s Cradle"}}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', august)).toThrow(/non-ISO-8601 Event\.startDate/);
  });

  it('rejects ISO-8601 datetime without a timezone (regression: silent local-time interpretation)', () => {
    // Without a TZ, V8 interprets the datetime as the SERVER's local
    // time per the ES spec — on a UTC-4 host, `2026-11-06T20:00:00`
    // becomes `2026-11-07T00:00:00.000Z` in postgres. Mandate an
    // explicit `Z` / `+HH:MM` / `+HHMM` offset.
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2026-11-06T20:00:00","location":{"@type":"Place","name":"Cat\'s Cradle"}}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(/non-ISO-8601 Event\.startDate/);
  });

  it('throws if Event.location is missing (was: silently attributed to default venue)', () => {
    // The docstring promises throw on missing location; before this fix
    // the code only validated name/startDate, so a location-less Event
    // mis-attributed to the site's `default_venue_slug`.
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2026-11-06T20:00:00-0500"}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(/missing Event\.location/);
  });

  it('matches the venue_name_to_slug map after trimming leading/trailing whitespace introduced by HTML entities (regression: trim divergence)', () => {
    // Iter-4 trimmed venueDisplayName for the writer but still passed the
    // raw (un-trimmed) location.name to resolveVenueSlug, causing the
    // `venue_name_to_slug['Cat’s Cradle Back Room']` lookup to miss
    // when JSON-LD had a leading `&nbsp;`. Fix: pass the trimmed value
    // to resolveVenueSlug too so both sides see the same string.
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"&nbsp;Cat’s Cradle Back Room"}}</script>';
    const parsed = parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/x/', html);
    if (parsed === null) throw new Error('expected fixture to parse');
    expect(parsed.venue_slug).toBe('cats-cradle-back-room');
    expect(parsed.venue_name).toBe('Cat’s Cradle Back Room');
  });

  it('throws if Event.location.name decodes to whitespace-only (e.g. JSON-LD name = "&nbsp;")', () => {
    // `&nbsp;` decodes to U+00A0 which is truthy but renders blank in
    // the UI; without a trim+empty-check the writer would happily insert
    // venues with a one-space name.
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"Band","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"&nbsp;"}}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(
      /Event\.location\.name decodes to empty\/whitespace/
    );
  });

  it('throws if Event.location.name is missing (regression: iter-1 only caught fully-absent location)', () => {
    // Same failure mode as missing-location: without a `name`,
    // resolveVenueSlug falls through to `default_venue_slug` and
    // silently attributes the event to the home room.
    const html =
      '<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","address":"300 E Main St."}}</script>';
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(/missing Event\.location\.name/);
  });

  it('throws if the derived source_id would overflow the varchar(256) column', () => {
    const longPath = '/event/' + 'a'.repeat(260) + '/';
    const url = `https://catscradle.com${longPath}`;
    const html = `<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"Cat's Cradle"}}</script>`;
    expect(() => parseEventPage(CATS_CRADLE, url, html)).toThrow(/source_id exceeds 256 chars/);
  });

  it('throws if the derived venue slug would overflow venues.slug varchar(64)', () => {
    const longVenueName = 'X'.repeat(80);
    const html = `<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"Band","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"${longVenueName}"}}</script>`;
    expect(() => parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/foo/', html)).toThrow(
      /venue slug exceeds 64 chars/
    );
  });

  it('throws if the derived venue address would overflow venues.address varchar(256)', () => {
    const longAddr = 'A'.repeat(260);
    const html = `<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"Band","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"Cat's Cradle","address":"${longAddr}"}}</script>`;
    expect(() => parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/foo/', html)).toThrow(
      /venue_address exceeds 256 chars/
    );
  });

  it('throws if the derived venue display name would overflow venues.name varchar(128)', () => {
    // A 200-char name slugifies down (consecutive non-alphanums collapse
    // to one '-') but the decoded display name itself still trips the
    // 128-char ceiling. Either way the parser MUST guard before postgres
    // throws — varchar overflow surfaces as a generic venue_resolve_error
    // tag, hiding the real (parser-side) root cause.
    const longName = 'A' + '&amp;'.repeat(200);
    const html = `<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"Band","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"${longName}"}}</script>`;
    expect(() => parseEventPage(CATS_CRADLE, 'https://catscradle.com/event/foo/', html)).toThrow(/exceeds/);
  });

  it('throws if Event.name exceeds the headlining_artist varchar(256) ceiling', () => {
    const longName = 'X'.repeat(257);
    const html = `<!-- Event Markup for Official Venue Sites --><script type="application/ld+json">{"@type":"Event","name":"${longName}","startDate":"2026-11-06T20:00:00-0500","location":{"@type":"Place","name":"Cat's Cradle"}}</script>`;
    expect(() => parseEventPage(CATS_CRADLE, 'https://x/event/y/', html)).toThrow(/exceeds 256 chars/);
  });

  it('source_id prefixes the site_slug so cross-site /event/<slug>/ paths cannot collide', () => {
    // Without the prefix, Cat's Cradle and Local 506 both serving
    // /event/sleater-kinney/ would UPSERT the same (source, source_id)
    // row and silently overwrite one another.
    const html = readFixture('cats-cradle-aaron-lee-tasjan.html');
    const url = 'https://catscradle.com/event/aaron-lee-tasjan-2/';
    const parsed = parseEventPage(CATS_CRADLE, url, html);
    if (parsed === null) throw new Error('expected fixture to parse');
    expect(parsed.source_id).toBe('cats-cradle:/event/aaron-lee-tasjan-2/');
  });
});
